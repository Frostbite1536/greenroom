import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
import { handle, ok } from "@/lib/api/http";
import { assertEventQueryBound, OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";

export const dynamic = "force-dynamic";

/**
 * GET /api/agenda — everything the agenda builder needs in one read: rooms,
 * tracks, and every session with its speakers and current placement. Sessions
 * without a `scheduleSlot` are the unscheduled backlog.
 */
export const GET = handle(async () => {
  const ctx = await requireContext(["ADMIN"]);

  const [rooms, tracks, sessions] = await Promise.all([
    // P-01: same caps and the same fail-closed shape as `getAgendaData` and
    // `getEventSettings`. The grid's axes were unbounded while the sessions
    // placed on them were capped.
    prisma.room.findMany({
      where: { eventId: ctx.eventId },
      orderBy: { sortOrder: "asc" },
      take: OPERATOR_QUERY_LIMITS.settingsRooms + 1,
    }),
    prisma.track.findMany({
      where: { eventId: ctx.eventId },
      orderBy: { sortOrder: "asc" },
      take: OPERATOR_QUERY_LIMITS.settingsTracks + 1,
    }),
    prisma.session.findMany({
      where: { eventId: ctx.eventId },
      include: {
        category: { select: { id: true, name: true } },
        speakers: { include: { user: { select: { id: true, name: true } } } },
        scheduleSlot: true,
      },
      // Same bound and stable order as `getAgendaData`, so the API twin and the
      // server-rendered builder cannot disagree about which sessions they hold.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: OPERATOR_QUERY_LIMITS.agendaSessions + 1,
    }),
  ]);
  assertEventQueryBound(rooms, OPERATOR_QUERY_LIMITS.settingsRooms, "rooms in the agenda builder");
  assertEventQueryBound(tracks, OPERATOR_QUERY_LIMITS.settingsTracks, "tracks in the agenda builder");

  return ok({
    rooms,
    tracks,
    truncated: sessions.length > OPERATOR_QUERY_LIMITS.agendaSessions,
    sessions: sessions.slice(0, OPERATOR_QUERY_LIMITS.agendaSessions).map((s) => ({
      id: s.id,
      title: s.title,
      format: s.format,
      durationMinutes: s.durationMinutes,
      // Additive: the proposal's topic, carried onto the talk at acceptance.
      category: s.category,
      speakers: s.speakers.map((sp) => ({
        userId: sp.userId,
        name: sp.user.name,
        isPrimary: sp.isPrimary,
      })),
      slot: s.scheduleSlot
        ? {
            id: s.scheduleSlot.id,
            roomId: s.scheduleSlot.roomId,
            trackId: s.scheduleSlot.trackId,
            startsAt: s.scheduleSlot.startsAt.toISOString(),
            endsAt: s.scheduleSlot.endsAt.toISOString(),
          }
        : null,
    })),
  });
});
