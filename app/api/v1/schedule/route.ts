import { prisma } from "@/lib/prisma";
import {
  authorizeV1EventScope,
  authorizeV1Request,
  getV1PaginationMeta,
  handleV1,
  parseV1ListQuery,
  v1EventWhere,
  v1Error,
  v1ListResponse,
} from "@/lib/api/v1";
import { serializeV1ScheduleSlot } from "@/lib/api/v1-serialize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/schedule?event=<slug|id>&limit=50&offset=0 */
export const GET = handleV1(async (req: Request): Promise<Response> => {
  const authorization = await authorizeV1Request(req.headers);
  if (!authorization.ok) return v1Error(authorization.error);

  const query = parseV1ListQuery(new URL(req.url).searchParams);
  if (!query.ok) return v1Error(query.error);

  // The credential's own scope is part of this predicate, not a check applied
  // after the fact: a per-event key resolving somebody else's selector matches
  // no row, so that event's data is never read and the refusal carries no
  // signal about whether it exists.
  const selected = await prisma.event.findFirst({
    where: v1EventWhere(authorization.scope, query.value.event),
    select: { id: true, name: true, slug: true, timezone: true },
  });
  const scoped = authorizeV1EventScope(authorization.scope, selected);
  if (!scoped.ok) return v1Error(scoped.error);
  const event = scoped.event;

  // ScheduleSlot is the placement record, so this cannot return backlog or
  // unplaced sessions. Every relation is reached through this event-scoped slot.
  //
  // The publication predicate applies here too. The v1 key is shared with
  // integrations and evaluators rather than held by the organizer alone, so
  // this is a publicly reachable read of the programme, not an admin one — a
  // talk the organizer has held back must not stay fetchable through it. One
  // `where` feeds both the page and the count, so `total` can never advertise
  // rows the page refuses to return.
  const where = { eventId: event.id, session: { contentStatus: "PUBLISHED" as const } };
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
});
