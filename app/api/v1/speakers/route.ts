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
import { serializeV1Speaker } from "@/lib/api/v1-serialize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/speakers?event=<slug|id>&limit=50&offset=0 */
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

  // A user is eligible only through an abstract or session for this one event;
  // membership and global user tables are intentionally not a source here.
  //
  // Both halves carry the publication predicate, because both can announce a
  // person the organizer has held back.
  //
  // The session half is the obvious one: an unpublished talk must not make its
  // speaker reachable, nor count toward their appearances.
  //
  // The abstract half needed the rule too, and this is the exact scenario the
  // unpublish control exists for. An organizer holds back a surprise keynote;
  // if that talk is the speaker's only appearance, the submission branch still
  // listed them — with `appearances.sessions` at zero, which is itself the
  // tell. So an abstract qualifies its speakers only when it has **no linked
  // Session** (accepted-but-unconverted, and submitted-but-undecided: the
  // participation case this branch exists for, where nothing has been withheld
  // because nothing was ever published) **or** its linked Session is PUBLISHED.
  // A submission whose talk was deliberately unpublished is not a separate
  // disclosure axis — it is the same talk, seen from the other end.
  const eventSessionSpeakers = { session: { eventId: event.id, contentStatus: "PUBLISHED" as const } };
  const eventAbstractSpeakers = {
    abstract: {
      eventId: event.id,
      OR: [
        { session: { is: null } },
        { session: { is: { contentStatus: "PUBLISHED" as const } } },
      ],
    },
  };
  const where = {
    OR: [
      { abstractSpeakers: { some: eventAbstractSpeakers } },
      { sessionSpeakers: { some: eventSessionSpeakers } },
    ],
  };
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
});
