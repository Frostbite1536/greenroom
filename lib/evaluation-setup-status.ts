import type { AbstractStatus } from "@prisma/client";

/**
 * The setup screen keeps decision history visible for coverage. A MAYBE is
 * still reviewable through its existing assignments, but it is never a target
 * for a new assignment.
 */
export const EVALUATION_SETUP_VISIBLE_STATUSES: AbstractStatus[] = [
  "SUBMITTED",
  "UNDER_REVIEW",
  "MAYBE",
  "ACCEPTED",
  "REJECTED",
  "WITHDRAWN",
];

export function isEvaluationSetupAssignable(status: AbstractStatus): boolean {
  return status === "SUBMITTED" || status === "UNDER_REVIEW";
}

export const EVALUATION_SETUP_STATUS_LABELS: Record<AbstractStatus, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under review",
  MAYBE: "Maybe",
  ACCEPTED: "Accepted",
  REJECTED: "Declined",
  WITHDRAWN: "Withdrawn",
};
