import type { AbstractStatus } from "@prisma/client";

/** The only programme-team choices accepted by the decision endpoint. */
export const ABSTRACT_DECISIONS = ["ACCEPTED", "MAYBE", "REJECTED"] as const;
export type AbstractDecision = (typeof ABSTRACT_DECISIONS)[number];

/** A withdrawal is final for every writer; every other state can be re-decided. */
export function canAdminDecide(status: AbstractStatus): boolean {
  return status !== "WITHDRAWN";
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
