import { prisma } from "@/lib/prisma";
import { ApiError, handle, ok } from "@/lib/api/http";
import { PUBLIC_AGENDA_LIMITS } from "@/lib/embed-schedule-view";
import { DEFAULT_PUBLIC_EVENT } from "@/lib/default-event";
import { publicSessionDescription } from "@/lib/public-session-copy";

export const dynamic = "force-dynamic";

/**
 * GET /api/agenda/public?event=<slug|id> — read-only scheduled agenda for the
 * embeddable, mobile-friendly schedule surface. Works with a null session and
 * only exposes placed sessions. Defaults to the demo event when unspecified.
 */
export const GET = handle(async (req) => {
  const eventParam = new URL(req.url).searchParams.get("event") ?? DEFAULT_PUBLIC_EVENT;

  const event = await prisma.event.findFirst({
    where: { OR: [{ id: eventParam }, { slug: eventParam }] },
    select: { id: true, name: true, slug: true, timezone: true },
  });
  if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found.");

  const [rooms, tracks, slots] = await Promise.all([
    prisma.room.findMany({ where: { eventId: event.id }, orderBy: { sortOrder: "asc" } }),
    prisma.track.findMany({ where: { eventId: event.id }, orderBy: { sortOrder: "asc" } }),
    prisma.scheduleSlot.findMany({
      // Only the published programme. Same predicate as the server-rendered
      // embed (`getPublicAgenda`), so the JSON twin cannot announce a talk the
      // page has stopped showing.
      where: { eventId: event.id, session: { contentStatus: "PUBLISHED" } },
      // Same bound and the same stable order as the embed, so the two cannot
      // disagree about which sessions fall inside the cap (S20).
      take: PUBLIC_AGENDA_LIMITS.sessions + 1,
      include: {
        room: { select: { id: true, name: true } },
        track: { select: { id: true, name: true, color: true } },
        session: {
          include: {
            category: { select: { id: true, name: true } },
            speakers: { include: { user: { select: { name: true } } } },
          },
        },
      },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    }),
  ]);

  return ok({
    event,
    rooms: rooms.map((r) => ({ id: r.id, name: r.name })),
    tracks: tracks.map((t) => ({ id: t.id, name: t.name, color: t.color })),
    // Additive and honest: a consumer that reads exactly the cap must be able
    // to tell a complete programme from a cut one.
    truncated: slots.length > PUBLIC_AGENDA_LIMITS.sessions,
    sessions: slots.slice(0, PUBLIC_AGENDA_LIMITS.sessions).map((slot) => ({
      slotId: slot.id,
      sessionId: slot.sessionId,
      title: slot.session.title,
      // The same sanitizer the server-rendered embed reads through, so the
      // JSON twin cannot publish a provenance note the page suppresses.
      description: publicSessionDescription(slot.session.description),
      format: slot.session.format,
      room: slot.room,
      track: slot.track,
      // Additive: the proposal's topic, carried onto the talk at acceptance.
      category: slot.session.category,
      startsAt: slot.startsAt.toISOString(),
      endsAt: slot.endsAt.toISOString(),
      speakers: slot.session.speakers.map((s) => ({ name: s.user.name, isPrimary: s.isPrimary })),
    })),
  });
});
