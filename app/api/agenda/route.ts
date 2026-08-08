import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
import { handle, ok } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/agenda — everything the agenda builder needs in one read: rooms,
 * tracks, and every session with its speakers and current placement. Sessions
 * without a `scheduleSlot` are the unscheduled backlog.
 */
export const GET = handle(async () => {
  const ctx = await requireContext(["ADMIN"]);

  const [rooms, tracks, sessions] = await Promise.all([
    prisma.room.findMany({ where: { eventId: ctx.eventId }, orderBy: { sortOrder: "asc" } }),
    prisma.track.findMany({ where: { eventId: ctx.eventId }, orderBy: { sortOrder: "asc" } }),
    prisma.session.findMany({
      where: { eventId: ctx.eventId },
      include: {
        speakers: { include: { user: { select: { id: true, name: true } } } },
        scheduleSlot: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return ok({
    rooms,
    tracks,
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      format: s.format,
      durationMinutes: s.durationMinutes,
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
