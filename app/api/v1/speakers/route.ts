import { prisma } from "@/lib/prisma";
import {
  authorizeV1Request,
  getV1PaginationMeta,
  parseV1ListQuery,
  v1Error,
  v1ListResponse,
} from "@/lib/api/v1";
import { serializeV1Speaker } from "@/lib/api/v1-serialize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/speakers?event=<slug|id>&limit=50&offset=0 */
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

  // A user is eligible only through an abstract or session for this one event;
  // membership and global user tables are intentionally not a source here.
  const where = {
    OR: [
      { abstractSpeakers: { some: { abstract: { eventId: event.id } } } },
      { sessionSpeakers: { some: { session: { eventId: event.id } } } },
    ],
  };
  const eventAbstractSpeakers = { abstract: { eventId: event.id } };
  const eventSessionSpeakers = { session: { eventId: event.id } };
  const [speakers, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        avatarUrl: true,
        speakerProfile: {
          select: {
            bio: true,
            company: true,
            jobTitle: true,
            headshotUrl: true,
            slideDeckUrl: true,
            socialLinks: true,
          },
        },
        _count: {
          select: {
            abstractSpeakers: { where: eventAbstractSpeakers },
            sessionSpeakers: { where: eventSessionSpeakers },
          },
        },
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      skip: query.value.offset,
      take: query.value.limit,
    }),
    prisma.user.count({ where }),
  ]);

  return v1ListResponse(
    speakers.map((speaker) =>
      serializeV1Speaker({
        ...speaker,
        appearances: {
          submissions: speaker._count.abstractSpeakers,
          sessions: speaker._count.sessionSpeakers,
        },
      }),
    ),
    event,
    getV1PaginationMeta(query.value, total),
  );
}
