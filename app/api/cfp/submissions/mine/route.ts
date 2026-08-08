import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
import { handle, ok } from "@/lib/api/http";
import { serializeSpeakerSubmission } from "@/lib/api/speaker-submission";

export const dynamic = "force-dynamic";

/** Bounded like the other operator reads: a speaker cannot have an unbounded roster. */
const MAX_SUBMISSIONS = 100;

/**
 * GET /api/cfp/submissions/mine — the signed-in user's own submissions (R1).
 *
 * Deliberately not role-gated beyond authentication: a co-speaker on an
 * abstract is not necessarily an event `SPEAKER` member, and the authorization
 * that matters is the `AbstractSpeaker` link, which is what this query filters
 * on. Still event-scoped to the caller's active event (INV-EVENT-001).
 *
 * Note the sibling route `GET /api/cfp/submissions` stays ADMIN/EVALUATOR-only:
 * it returns every abstract in the event.
 */
export const GET = handle(async () => {
  const ctx = await requireContext();

  const abstracts = await prisma.abstract.findMany({
    where: {
      eventId: ctx.eventId,
      speakers: { some: { userId: ctx.userId } },
    },
    include: {
      category: true,
      speakers: { include: { user: true } },
      answers: true,
      formConfig: { select: { id: true, name: true, slug: true } },
      session: { select: { id: true, scheduleSlot: { select: { id: true } } } },
      // Review assignments/scores are intentionally NOT included: a speaker
      // must not see their own review data.
    },
    orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }],
    take: MAX_SUBMISSIONS,
  });

  return ok({ submissions: abstracts.map(serializeSpeakerSubmission) });
});
