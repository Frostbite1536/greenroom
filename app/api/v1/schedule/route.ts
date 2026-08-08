import { prisma } from "@/lib/prisma";
import {
  authorizeV1Request,
  getV1PaginationMeta,
  parseV1ListQuery,
  v1Error,
  v1ListResponse,
} from "@/lib/api/v1";
import { serializeV1ScheduleSlot } from "@/lib/api/v1-serialize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/schedule?event=<slug|id>&limit=50&offset=0 */
export async function GET(req: Request): Promise<Response> {
  const authorization = authorizeV1Request(req.headers);
  if (!authorization.ok) return v1Error(authorization.error);

  const query = parseV1ListQuery(new URL(req.url).searchParams);
  if (!query.ok) return v1Error(query.error);

  const event = await prisma.event.findFirst({
    where: { OR: [{ id: query.value.event }, { slug: query.value.event }] },
    select: { id: true, name: true, slug: true, timezone: true },
  });
  if (!event) {
    return v1Error({ status: 404, code: "EVENT_NOT_FOUND", message: "Event not found." });
  }

  // ScheduleSlot is the placement record, so this cannot return backlog or
  // unplaced sessions. Every relation is reached through this event-scoped slot.
  const where = { eventId: event.id };
  const [slots, total] = await Promise.all([
    prisma.scheduleSlot.findMany({
      where,
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        room: { select: { id: true, name: true, capacity: true } },
        track: { select: { id: true, name: true, color: true } },
        session: {
          select: {
            id: true,
            title: true,
            description: true,
            format: true,
            durationMinutes: true,
            speakers: {
              select: { isPrimary: true, user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
              orderBy: [{ isPrimary: "desc" }, { userId: "asc" }],
            },
          },
        },
      },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      skip: query.value.offset,
      take: query.value.limit,
    }),
    prisma.scheduleSlot.count({ where }),
  ]);

  return v1ListResponse(
    slots.map(serializeV1ScheduleSlot),
    event,
    getV1PaginationMeta(query.value, total),
  );
}
