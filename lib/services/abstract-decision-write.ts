import type { Prisma } from "@prisma/client";
import { lockAbstractForWrite } from "@/lib/services/abstract-lock";
import {
  bulkDecisionEligibility,
  canAdminDecide,
  decisionProvisionsSession,
  decisionTimestamp,
  maybeBlockedByConfirmedSession,
  sessionPublicationForDecision,
  type AbstractDecision,
} from "@/lib/services/abstract-decision";
import {
  AUDITED_ABSTRACT_DECISION_FIELDS,
  diffChanges,
  recordAudit,
} from "@/lib/services/audit-log";
import { provisionAcceptedAbstract } from "@/lib/services/session-provisioning";

/**
 * The one locked write that turns a programme-team choice into stored truth.
 *
 * This is the body `POST /api/evaluations/decisions` has always run, lifted out
 * of the route unchanged so a second caller can reuse it instead of writing a
 * second version of it. Nothing about the transaction changed: the per-abstract
 * advisory lock is still taken first (INV-ABSTRACT-001), the status is still
 * re-read under it, acceptance still provisions the confirmed `Session` and the
 * onboarding checklist in the same transaction (INV-DOMAIN-001, INV-TASK-001),
 * and a reversal still only unpublishes.
 *
 * It exists because bulk decisions must run the *same* path, one abstract at a
 * time. A batch is a loop over this function with one transaction each — never
 * one transaction spanning the selection. Fifty proposals sharing a transaction
 * would hold fifty advisory locks against every speaker edit and conversion for
 * the length of the slowest provisioning, and would throw away forty-nine
 * correct writes to report the fiftieth's refusal.
 *
 * **This function never sends mail.** A decision is not a decision email:
 * `POST /api/comms/decision` is preview-gated and bound by an HMAC proof to the
 * exact content and recipients an admin previewed. Nothing here may reach it.
 *
 * Refusals are returned rather than thrown so both callers can shape them: the
 * single-row route raises the `ApiError` it always did, and the bulk route turns
 * the same code into a named skip beside the rows it did write.
 */

/** The refusal vocabulary, owned here so both callers speak it identically. */
export const ABSTRACT_DECISION_REFUSALS = {
  ABSTRACT_NOT_FOUND: { status: 404, message: "Abstract not found." },
  ABSTRACT_WITHDRAWN: { status: 409, message: "This abstract has been withdrawn." },
  MAYBE_NOT_AVAILABLE: {
    status: 409,
    message: "Maybe is only available before a proposal becomes a confirmed Session.",
  },
  // Reachable only when the caller asked for the awaiting-a-decision gate, so
  // the single-row route's re-decision contract is untouched.
  ABSTRACT_ALREADY_DECIDED: {
    status: 409,
    message: "This proposal already has a decision. Open it and use “Change decision” to change it.",
  },
  ABSTRACT_NOT_SUBMITTED: {
    status: 409,
    message: "This proposal is still a draft and has not been submitted for a decision.",
  },
} as const;

export type AbstractDecisionRefusalCode = keyof typeof ABSTRACT_DECISION_REFUSALS;

export type AbstractDecisionWritten = {
  decided: true;
  decision: AbstractDecision;
  /** The confirmed talk this proposal now has, created or pre-existing. */
  sessionId: string | null;
  /** True only when THIS write built it — never true for a re-accept. */
  sessionCreated: boolean;
  /** Checklist rows actually inserted by this write, never a total. */
  tasksAssigned: number;
  topicReconciled: boolean;
  summaryReconciled: boolean;
};

export type AbstractDecisionWriteResult =
  | AbstractDecisionWritten
  | { decided: false; refusal: AbstractDecisionRefusalCode };

export type AbstractDecisionWriteInput = {
  abstractId: string;
  /** The caller's own event. A row outside it is reported as not found. */
  eventId: string;
  /**
   * The admin whose decision this is, for the change history. Required, not
   * optional: an unattributed decision is the gap the external audit found, and
   * both callers already hold `ctx.userId`, so the compiler is what keeps a third
   * caller from recording an anonymous one.
   */
  actorUserId: string;
  decision: AbstractDecision;
  /**
   * When true, only a proposal still awaiting a decision is written; anything
   * already decided, withdrawn, or still a draft is refused by name. The bulk
   * caller sets this. The single-row route leaves it false, keeping its
   * long-standing "a decision is reversible" contract exactly as it was.
   */
  requireAwaitingDecision?: boolean;
  /** Injectable so the stamped timestamp is deterministic under test. */
  now?: Date;
};

/**
 * Must run inside a transaction, and takes the per-abstract advisory lock as its
 * first statement. Callers pass the transaction client; they do not pre-lock.
 */
export async function writeAbstractDecision(
  tx: Prisma.TransactionClient,
  input: AbstractDecisionWriteInput,
): Promise<AbstractDecisionWriteResult> {
  // Same per-abstract advisory lock as the speaker PATCH and conversion:
  // every writer that checks-then-writes this abstract serializes here, so a
  // decision cannot interleave with an in-flight speaker edit (and vice
  // versa) between its status read and its write.
  await lockAbstractForWrite(tx, input.abstractId);

  const abstract = await tx.abstract.findUnique({
    where: { id: input.abstractId },
    select: { eventId: true, status: true, session: { select: { id: true } } },
  });
  // A row in another event is reported exactly as a missing one. Distinguishing
  // them would make this endpoint an existence oracle for other events' ids.
  if (!abstract || abstract.eventId !== input.eventId) {
    return { decided: false, refusal: "ABSTRACT_NOT_FOUND" };
  }
  if (!canAdminDecide(abstract.status)) {
    return { decided: false, refusal: "ABSTRACT_WITHDRAWN" };
  }
  if (input.requireAwaitingDecision) {
    const eligibility = bulkDecisionEligibility(abstract.status);
    if (eligibility !== "ELIGIBLE") return { decided: false, refusal: eligibility };
  }
  if (maybeBlockedByConfirmedSession(input.decision, Boolean(abstract.session))) {
    return { decided: false, refusal: "MAYBE_NOT_AVAILABLE" };
  }

  const decided = await tx.abstract.update({
    where: { id: input.abstractId },
    // MAYBE keeps an abstract in review: it carries no final-decision
    // timestamp, can be scored/re-decided later, and never provisions.
    data: {
      status: input.decision,
      decidedAt: decisionTimestamp(input.decision, input.now ?? new Date()),
    },
    include: {
      speakers: { select: { userId: true, isPrimary: true } },
      // `categoryId` so re-accepting can reconcile a topic that moved on the
      // proposal after the talk was created, and `description` so it can
      // reconcile the attendee-facing summary the public programme prints.
      // Both read under the same abstract lock as the write that follows.
      session: { select: { id: true, categoryId: true, description: true } },
    },
  });

  // Rejecting deliberately provisions nothing and removes nothing: an already
  // confirmed session stays on the programme for the admin to unschedule
  // (INV-DOMAIN-001, W2), and its speakers keep any tasks they are working on
  // for other talks.
  const provisioned = decisionProvisionsSession(input.decision)
    ? await provisionAcceptedAbstract(tx, decided)
    : {
        sessionId: decided.session?.id ?? null,
        created: false,
        topicReconciled: false,
        summaryReconciled: false,
        tasksAssigned: 0,
      };

  // Nothing is deleted, but a reversed decision must stop speaking publicly.
  // Scoped to this abstract's own Session by its unique `sourceAbstractId`,
  // inside the same advisory lock as the status write, so the public
  // programme can never disagree with the decision that produced it.
  const publication = sessionPublicationForDecision(input.decision);
  if (publication && provisioned.sessionId) {
    await tx.session.update({
      where: { id: provisioned.sessionId },
      data: { contentStatus: publication },
    });
  }

  // W24 / INV-AUDIT-001: the decision's history row commits with the decision,
  // inside the same per-abstract advisory lock — so a bulk batch produces one
  // attributed row per proposal it actually wrote, and none for the ones it
  // skipped. The "from" is the status read under the lock above, which is the
  // value this write replaced.
  //
  // Re-deciding to the status a proposal already holds records nothing: the diff
  // is empty. That is the same rule everywhere else in the history, and it keeps
  // a re-accept that only tops up provisioning from reading as a new decision.
  await recordAudit(tx, {
    eventId: input.eventId,
    actorUserId: input.actorUserId,
    entityType: "ABSTRACT_DECISION",
    entityId: input.abstractId,
    action: "DECIDE",
    changes: diffChanges(
      { status: abstract.status },
      { status: decided.status },
      AUDITED_ABSTRACT_DECISION_FIELDS,
    ),
  });

  return {
    decided: true,
    decision: input.decision,
    sessionId: provisioned.sessionId,
    sessionCreated: provisioned.created,
    tasksAssigned: provisioned.tasksAssigned,
    topicReconciled: provisioned.topicReconciled,
    summaryReconciled: provisioned.summaryReconciled,
  };
}
