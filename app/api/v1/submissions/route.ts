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
import { serializeV1Submission } from "@/lib/api/v1-serialize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/submissions?event=<slug|id>&limit=50&offset=0 */
export const GET = handleV1(async (req: Request): Promise<Response> => {
  // Keep this check before parsing and before any programme read, so an
  // untrusted request cannot probe events or reach event data without an
  // accepted credential. It is no longer true that the surface touches no
  // database at all first: authenticating a per-event `grk_` credential costs
  // one indexed point read of the credential table. That read reaches no
  // programme data and no event row, and the published contract states it.
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

  const where = { eventId: event.id };
  const [submissions, total] = await Promise.all([
    prisma.abstract.findMany({
      where,
      select: {
        id: true,
        title: true,
        abstract: true,
        format: true,
        durationMinutes: true,
        status: true,
        submittedAt: true,
        createdAt: true,
        updatedAt: true,
        formConfig: { select: { id: true, name: true, slug: true } },
        category: { select: { id: true, name: true } },
        speakers: {
          select: { isPrimary: true, user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
          orderBy: [{ isPrimary: "desc" }, { userId: "asc" }],
        },
        answers: {
          select: { value: true, formField: { select: { key: true } } },
          orderBy: { id: "asc" },
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      skip: query.value.offset,
      take: query.value.limit,
    }),
    prisma.abstract.count({ where }),
  ]);

  return v1ListResponse(
    submissions.map(serializeV1Submission),
    event,
    getV1PaginationMeta(query.value, total),
  );
});
