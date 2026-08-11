import type { AbstractStatus } from "@prisma/client";

/** The only programme-team choices accepted by the decision endpoint. */
export const ABSTRACT_DECISIONS = ["ACCEPTED", "MAYBE", "REJECTED"] as const;
export type AbstractDecision = (typeof ABSTRACT_DECISIONS)[number];

/** A withdrawal is final for every writer; every other state can be re-decided. */
export function canAdminDecide(status: AbstractStatus): boolean {
  return status !== "WITHDRAWN";
}

/**
 * Why a proposal is, or is not, eligible for a decision taken over a selection.
 *
 * The single-row path deliberately allows a re-decision: the drawer makes the
 * organizer press "Change decision" first, so reversing an outcome is an
 * explicit second click on one named proposal. A bulk action has no such click —
 * a tick box carries no evidence that the operator saw what that row already
 * decided — so a selection that happens to include a declined proposal must not
 * silently reverse it. Bulk therefore writes only proposals that are still
 * awaiting a decision, which is exactly the set the drawer offers buttons for
 * without "Change decision" (`SUBMITTED`, `UNDER_REVIEW`).
 *
 * Everything else is named rather than refused as a batch: an ineligible row is
 * a skip with this reason attached, and the other rows are still written.
 *
 * The switch is exhaustive over `AbstractStatus` on purpose — a status added to
 * the schema fails to compile here rather than quietly defaulting to eligible.
 */
export type BulkDecisionEligibility =
  | "ELIGIBLE"
  | "ABSTRACT_WITHDRAWN"
  | "ABSTRACT_ALREADY_DECIDED"
  | "ABSTRACT_NOT_SUBMITTED";

export function bulkDecisionEligibility(status: AbstractStatus): BulkDecisionEligibility {
  switch (status) {
    case "SUBMITTED":
    case "UNDER_REVIEW":
      return "ELIGIBLE";
    case "ACCEPTED":
    case "MAYBE":
    case "REJECTED":
      return "ABSTRACT_ALREADY_DECIDED";
    case "WITHDRAWN":
      return "ABSTRACT_WITHDRAWN";
    case "DRAFT":
      return "ABSTRACT_NOT_SUBMITTED";
  }
}

/** MAYBE is a pre-confirmation review state; a linked Session is programme truth. */
export function maybeBlockedByConfirmedSession(
  decision: AbstractDecision,
  hasConfirmedSession: boolean,
): boolean {
  return decision === "MAYBE" && hasConfirmedSession;
}

/** MAYBE is a review state, not a final programme decision. */
export function decisionTimestamp(decision: AbstractDecision, now: Date): Date | null {
  return decision === "MAYBE" ? null : now;
}

/** Acceptance alone makes an Abstract into a confirmed Session and task cohort. */
export function decisionProvisionsSession(decision: AbstractDecision): boolean {
  return decision === "ACCEPTED";
}

/**
 * What a final decision means for the linked Session's place on the public
 * programme, or `null` when the decision does not speak to publication.
 *
 * This closes a real leak rather than restating the decision: rejecting an
 * abstract that was already accepted left its Session scheduled and publicly
 * visible, because nothing is ever deleted (INV-DOMAIN-001, W2). Reversing the
 * decision now unpublishes the talk — the row, its slot, its speakers and their
 * tasks all survive untouched, so re-accepting restores it and the admin can
 * still unschedule deliberately.
 *
 * MAYBE returns null: it cannot coexist with a Session at all, and a review
 * state is not a publication instruction.
 */
export function sessionPublicationForDecision(
  decision: AbstractDecision,
): "PUBLISHED" | "DRAFT" | null {
  if (decision === "ACCEPTED") return "PUBLISHED";
  if (decision === "REJECTED") return "DRAFT";
  return null;
}
