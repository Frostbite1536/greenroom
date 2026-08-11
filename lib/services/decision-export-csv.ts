import { formatDecisionScore } from "@/lib/decision-summary-display";
import { roundLabel } from "@/lib/round-label";
import { CRLF, csvCell, csvFilename, csvRow } from "@/lib/services/csv";
import type {
  AdminDecisionAbstractSummary,
  AdminDecisionPlan,
} from "@/lib/services/admin-decision-summary";

/**
 * CSV rendering for the ADMIN review-results export (ABS-13).
 *
 * Pure and database-free: the route supplies rows that are already bounded and
 * ordered, and the aggregate numbers come verbatim from
 * `lib/services/admin-decision-summary.ts`. No aggregation rule is re-derived
 * here — a second implementation of "which reviews count" is exactly how an
 * export ends up disagreeing with the screen it was exported from.
 *
 * Blind-review policy: the summary deliberately projects only *counts* and a
 * weighted average, never an evaluator id, name, or per-reviewer score. This
 * file therefore has no access to an evaluator identity and must never be given
 * one — the export can only ever be as revealing as the decision table itself.
 */

/**
 * The cell escaper and record separator moved to `@/lib/services/csv` when the
 * reports lane added three more exports; they are re-exported here so this
 * module's existing callers and tests keep their import unchanged. There is
 * still exactly one implementation of the formula guard in the codebase.
 */
export { csvCell, csvRow };

/**
 * Column order is part of the contract: a saved spreadsheet template breaks if
 * columns move, so append rather than reorder.
 */
export const DECISION_EXPORT_HEADER = [
  "abstract_id",
  "title",
  "status",
  "category",
  "speakers",
  "submitted_at",
  "decided_at",
  "review_round",
  "completed_reviews",
  "included_reviews",
  "weighted_average",
] as const;

/**
 * One proposal as the admin decision surface already serializes it. Speaker
 * *names* only: the organizer decision table drops speaker email on purpose,
 * and an export is not the place to quietly widen a projection.
 */
export type DecisionExportRow = {
  id: string;
  title: string;
  status: string;
  categoryName: string | null;
  speakerNames: readonly string[];
  submittedAt: string | null;
  decidedAt: string | null;
};

export type DecisionExportInput = {
  rows: readonly DecisionExportRow[];
  summariesByAbstractId: Readonly<Record<string, AdminDecisionAbstractSummary>>;
  selectedPlan: AdminDecisionPlan | null;
  /** Total proposals in the event, so truncation can be stated in real terms. */
  total: number;
  /** True when the event holds more proposals than this bounded export carries. */
  hasMore: boolean;
};

/**
 * Round label, character-for-character the admin table's `planLabel`, so the
 * export names the round the operator selected on screen. Both now compose it
 * through `@/lib/round-label`, which is what keeps them identical *and* stops
 * the shared "Round 1 — Round 1 — Program Committee" duplication. `null`
 * becomes an empty cell rather than the word "none": an event with no
 * evaluation plan has no round, and inventing a name for it would be a lie.
 */
function exportRoundLabel(plan: AdminDecisionPlan | null): string {
  return plan ? roundLabel(plan) : "";
}

/**
 * Render the export. A truncated export ends with a comment row saying so, in
 * the first column, so the honesty survives being opened in a spreadsheet — a
 * silently short export is the failure mode that actually misleads an organizer
 * (S20: bounded reads report their bound rather than hiding it).
 *
 * The notice states what the file contains and stops there. It deliberately
 * recommends no next step: this route takes only `planId`, so telling an
 * operator to narrow by status or form would send them looking for a control
 * the export does not have. An unreachable older proposal is a real limit of
 * this slice and is named as one rather than dressed up as a workflow.
 */
export function buildDecisionExportCsv(input: DecisionExportInput): string {
  const lines: string[] = [csvRow(DECISION_EXPORT_HEADER)];
  const round = exportRoundLabel(input.selectedPlan);

  for (const row of input.rows) {
    const summary = input.summariesByAbstractId[row.id];
    lines.push(
      csvRow([
        row.id,
        row.title,
        row.status,
        row.categoryName,
        row.speakerNames.join("; "),
        row.submittedAt,
        row.decidedAt,
        round,
        // An abstract missing from the summary map is reported as blank rather
        // than as zero completed reviews, which would read as a real finding.
        summary ? summary.completedAssignments : null,
        summary ? summary.includedReviews : null,
        summary ? formatDecisionScore(summary.weightedAverage) : null,
      ]),
    );
  }

  if (input.hasMore) {
    lines.push(
      csvRow([
        `# Truncated: this export contains the newest ${input.rows.length} of ${input.total} recorded proposals; older proposals are not included in this export.`,
      ]),
    );
  }

  return lines.join(CRLF) + CRLF;
}

/** Fixed, input-free download name: nothing user-supplied reaches the header. */
export function decisionExportFilename(now: Date = new Date()): string {
  return csvFilename("review-results", now);
}
