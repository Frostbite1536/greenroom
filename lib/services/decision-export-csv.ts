import { formatDecisionScore } from "@/lib/decision-summary-display";
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

/** RFC 4180 record separator. Excel and Sheets both expect CRLF. */
const CRLF = "\r\n";

/**
 * Leading characters a spreadsheet treats as the start of a formula. A cell
 * beginning with one is prefixed with `'` so an imported proposal title can
 * never execute in the recipient's spreadsheet.
 */
const FORMULA_LEAD = new Set(["=", "+", "-", "@", "\t", "\r"]);

/**
 * Escape one cell: formula guard first, then RFC 4180 quoting.
 *
 * The guard runs before quoting so the apostrophe lands inside the quoted
 * value. It is applied to every cell, including numeric ones, which means a
 * negative weighted average exports as text rather than a number. That is the
 * intended trade: a safe export beats a marginally tidier one for a value that
 * only occurs with a negative-scored rubric.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "number" ? String(value) : value;
  if (raw === "") return "";
  const guarded = FORMULA_LEAD.has(raw[0]) ? `'${raw}` : raw;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function csvRow(cells: readonly (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}

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
 * export names the round the operator selected on screen. `null` becomes an
 * empty cell rather than the word "none": an event with no evaluation plan has
 * no round, and inventing a name for it would be a lie.
 */
function roundLabel(plan: AdminDecisionPlan | null): string {
  return plan ? `Round ${plan.ordinal} — ${plan.name}` : "";
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
  const round = roundLabel(input.selectedPlan);

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
  return `greenroom-review-results-${now.toISOString().slice(0, 10)}.csv`;
}
