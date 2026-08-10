import { prisma } from "@/lib/prisma";
import { ApiError, handle, ok } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/agenda/public?event=<slug|id> — read-only scheduled agenda for the
 * embeddable, mobile-friendly schedule surface. Works with a null session and
 * only exposes placed sessions. Defaults to the demo event when unspecified.
 */
export const GET = handle(async (req) => {
  const eventParam = new URL(req.url).searchParams.get("event") ?? "forward-2026";

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
      orderBy: [{ startsAt: "asc" }],
    }),
  ]);

  return ok({
    event,
    rooms: rooms.map((r) => ({ id: r.id, name: r.name })),
    tracks: tracks.map((t) => ({ id: t.id, name: t.name, color: t.color })),
    sessions: slots.map((slot) => ({
      slotId: slot.id,
      sessionId: slot.sessionId,
      title: slot.session.title,
      description: slot.session.description,
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
