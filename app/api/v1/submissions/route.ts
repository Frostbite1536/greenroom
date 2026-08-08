import { prisma } from "@/lib/prisma";
import {
  authorizeV1Request,
  getV1PaginationMeta,
  handleV1,
  parseV1ListQuery,
  v1Error,
  v1ListResponse,
} from "@/lib/api/v1";
import { serializeV1Submission } from "@/lib/api/v1-serialize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/submissions?event=<slug|id>&limit=50&offset=0 */
export const GET = handleV1(async (req: Request): Promise<Response> => {
  // Keep this check before parsing or querying so an untrusted request cannot
  // probe events or cause any database work without a configured valid key.
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
