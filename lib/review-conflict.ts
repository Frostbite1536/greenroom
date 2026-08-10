/**
 * Declaring a conflict of interest on an assigned proposal (ABS-12).
 *
 * A reviewer who recognises a colleague, a competitor or their own employer in
 * a proposal needs a way to step back from it. The assignment lifecycle already
 * has the state for that — `DECLINED`, written today only by the C6 withdrawal
 * path — so this is one rule shared by the button and the route rather than a
 * new status or a new lifecycle.
 *
 * The rule lives here, not in either consumer, so the control the reviewer sees
 * and the refusal the server enforces can never disagree about what is allowed.
 */

export type ReviewAssignmentStatus = "ASSIGNED" | "IN_PROGRESS" | "COMPLETED" | "DECLINED";

/** The states a reviewer can still step back from. */
export const CONFLICT_DECLINABLE_STATUSES = ["ASSIGNED", "IN_PROGRESS"] as const;

export type ConflictRefusal = { status: number; code: string; message: string };

/**
 * Why this assignment cannot be declined, or null when it can be.
 *
 * A withdrawn proposal is refused with the *same* code and wording the score
 * route uses, so a reviewer meets one explanation for one situation.
 *
 * A completed review is refused deliberately rather than silently overwritten:
 * `admin-decision-summary` aggregates scores only from `COMPLETED` assignments,
 * so flipping a finished review to `DECLINED` would quietly drop scores that
 * already counted towards a decision. Withdrawing a submitted opinion is an
 * operator action, not a self-service one.
 */
export function conflictDeclineRefusal(
  assignmentStatus: ReviewAssignmentStatus,
  abstractWithdrawn: boolean,
): ConflictRefusal | null {
  if (abstractWithdrawn) {
    return {
      status: 409,
      code: "ABSTRACT_WITHDRAWN",
      message: "The speaker withdrew this proposal, so it no longer needs a review.",
    };
  }
  if (assignmentStatus === "DECLINED") {
    return {
      status: 409,
      code: "CONFLICT_ALREADY_DECLARED",
      message: "You have already declared a conflict on this proposal.",
    };
  }
  if (assignmentStatus === "COMPLETED") {
    return {
      status: 409,
      code: "REVIEW_ALREADY_SUBMITTED",
      message:
        "You already submitted this review, and it counts towards the decision. Ask an admin to remove it before stepping back.",
    };
  }
  return null;
}

/**
 * Why a score write must be refused on the caller's own assignment, or null.
 *
 * A declared conflict has to survive a score write, and not only a racing one:
 * before this rule existed the score route checked the abstract's status but
 * never the assignment's, so a `DECLINED` row could be scored straight back to
 * `COMPLETED` — silently reversing the declaration and letting the stepped-back
 * evaluator's scores count towards the decision.
 *
 * Withdrawal is checked ahead of this by the caller, so a reviewer whose row was
 * declined *by* a withdrawal still meets the withdrawal explanation.
 */
export function scoreWriteRefusal(
  assignmentStatus: ReviewAssignmentStatus,
): ConflictRefusal | null {
  if (assignmentStatus !== "DECLINED") return null;
  return {
    status: 409,
    code: "ASSIGNMENT_DECLINED",
    message:
      "You declared a conflict of interest on this proposal, so it is no longer yours to score. Ask an admin to reassign it.",
  };
}

/**
 * Restoring a declined assignment.
 *
 * An explicit admin re-assignment of the same (plan, abstract, evaluator) is the
 * restoration signal. It must apply to `DECLINED` rows only: a `COMPLETED` row
 * carries a real review, and resetting it would strip that review out of the
 * decision aggregate, which reads only completed assignments.
 */
export const RESTORABLE_ASSIGNMENT_STATUSES = ["DECLINED"] as const;

export function isRestoredByReassignment(assignmentStatus: ReviewAssignmentStatus): boolean {
  return (RESTORABLE_ASSIGNMENT_STATUSES as readonly string[]).includes(assignmentStatus);
}

/** Whether the reviewer should be offered the declare-a-conflict control. */
export function canDeclareConflict(
  assignmentStatus: ReviewAssignmentStatus,
  abstractWithdrawn: boolean,
): boolean {
  return conflictDeclineRefusal(assignmentStatus, abstractWithdrawn) === null;
}

/**
 * Whether a queue row is still part of the reviewer's active workload.
 *
 * `COMPLETED` stays active — it is the finished half of the progress bar. A
 * declined row has left the queue, and so has a withdrawn proposal, so neither
 * may keep the reviewer's progress below 100% or be opened for scoring.
 */
export function isActiveQueueAssignment(
  assignmentStatus: ReviewAssignmentStatus,
  abstractWithdrawn: boolean,
): boolean {
  return !abstractWithdrawn && assignmentStatus !== "DECLINED";
}

/**
 * Whether a declined row is a conflict declaration rather than a withdrawal.
 *
 * `DECLINED` has exactly two writers: the C6 withdrawal path, which also sets
 * the abstract to `WITHDRAWN`, and this feature. A declined assignment on a
 * proposal that still stands is therefore always a declared conflict, and the
 * queue may name it as one.
 */
export function isDeclaredConflict(
  assignmentStatus: ReviewAssignmentStatus,
  abstractWithdrawn: boolean,
): boolean {
  return assignmentStatus === "DECLINED" && !abstractWithdrawn;
}
