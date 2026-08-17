import { prisma } from "@/lib/prisma";
import { abstractDecisionSchema } from "@/types/api";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { serializeAbstract } from "@/lib/api/abstract-serialize";
import {
  ABSTRACT_DECISION_REFUSALS,
  writeAbstractDecision,
} from "@/lib/services/abstract-decision-write";

export const dynamic = "force-dynamic";

/**
 * POST /api/evaluations/decisions — accept, maybe, or reject an abstract (admin).
 *
 * Accepting is the moment a proposal becomes a talk, so it now provisions the
 * whole thing in one locked transaction (WAVE1-B1, director requirement #4):
 * the confirmed `Session` (with its speakers) and every speaker's onboarding
 * checklist. Both steps are idempotent, so re-accepting tops up what is missing
 * instead of duplicating. `/api/evaluations/convert` remains for legacy
 * accepted abstracts without Sessions and for manual checklist backfill.
 *
 * MAYBE is available only before the proposal has a confirmed Session. Once a
 * Session exists, moving back to a review state would split public programme
 * truth and would promise withdrawal while the Session guard correctly blocks
 * it. Existing final-decision reversals still never delete a Session; C10 owns
 * one publication rule across those legacy consumers.
 *
 * The locked write itself lives in `lib/services/abstract-decision-write.ts`
 * because `POST /api/evaluations/decisions/bulk` loops the same function, one
 * transaction per abstract. This route's own contract is unchanged: it still
 * allows a re-decision (the drawer gates that behind "Change decision"), so it
 * does not pass `requireAwaitingDecision`, and it still raises the same three
 * refusals with the same statuses, codes and messages — now read from the
 * service's own table so the two callers cannot drift.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, abstractDecisionSchema);

  const updated = await prisma.$transaction(async (tx) => {
    const result = await writeAbstractDecision(tx, {
      abstractId: input.abstractId,
      eventId: ctx.eventId,
      // Attribution for the change history the service appends inside this
      // transaction (W24); the decision itself is unchanged.
      actorUserId: ctx.userId,
      decision: input.decision,
    });
    if (!result.decided) {
      const refusal = ABSTRACT_DECISION_REFUSALS[result.refusal];
      throw new ApiError(refusal.status, result.refusal, refusal.message);
    }
    const provisioned = {
      created: result.sessionCreated,
      tasksAssigned: result.tasksAssigned,
      topicReconciled: result.topicReconciled,
    };

    const full = await tx.abstract.findUniqueOrThrow({
      where: { id: input.abstractId },
      include: {
        category: true,
        speakers: { include: { user: true } },
        session: {
          select: {
            id: true,
            title: true,
            scheduleSlot: {
              select: { startsAt: true, room: { select: { name: true } } },
            },
          },
        },
      },
    });
    return { abstract: full, provisioned };
  });

  const { abstract: decided, provisioned } = updated;
  return ok({
    ...serializeAbstract(decided),
    // Additive keys: existing clients that ignore them are unaffected.
    session: decided.session
      ? {
          id: decided.session.id,
          title: decided.session.title,
          isScheduled: Boolean(decided.session.scheduleSlot),
          scheduledAt: decided.session.scheduleSlot?.startsAt.toISOString() ?? null,
          roomName: decided.session.scheduleSlot?.room.name ?? null,
        }
      : null,
    // What accepting just built, so the UI can confirm it in plain language.
    sessionCreated: provisioned.created,
    tasksAssigned: provisioned.tasksAssigned,
    // Additive: true when re-accepting brought a stale topic back in line.
    topicReconciled: provisioned.topicReconciled,
  });
});
