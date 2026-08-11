import type { Prisma } from "@prisma/client";
import { lockAbstractForWrite } from "@/lib/services/abstract-lock";
import {
  canAdminDecide,
  decisionProvisionsSession,
  decisionTimestamp,
  maybeBlockedByConfirmedSession,
  sessionPublicationForDecision,
  type AbstractDecision,
} from "@/lib/services/abstract-decision";
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
 * It is a function rather than route code so a second caller can run the same
 * path one abstract at a time, taking one transaction per abstract, instead of
 * growing a second copy of the accept semantics.
 *
 * **This function never sends mail.** A decision is not a decision email:
 * `POST /api/comms/decision` is preview-gated and bound by an HMAC proof to the
 * exact content and recipients an admin previewed. Nothing here may reach it.
 *
 * Refusals are returned rather than thrown so a caller can shape them: the
 * single-row route raises the `ApiError` it always did.
 */

/** The refusal vocabulary, owned here so every caller speaks it identically. */
export const ABSTRACT_DECISION_REFUSALS = {
  ABSTRACT_NOT_FOUND: { status: 404, message: "Abstract not found." },
  ABSTRACT_WITHDRAWN: { status: 409, message: "This abstract has been withdrawn." },
  MAYBE_NOT_AVAILABLE: {
    status: 409,
    message: "Maybe is only available before a proposal becomes a confirmed Session.",
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
  decision: AbstractDecision;
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
