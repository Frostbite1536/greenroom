/**
 * Sorting the **decision score** column of the admin abstracts table (ABS-10,
 * D-C5-8 §3.2).
 *
 * Deliberately its own module, its own state type and its own comparator, with
 * no import from `lib/review-coverage-sort.ts`. The two tables answer different
 * questions on different screens; a shared comparator would mean tuning one
 * silently reordering the other, and a shared state would mean sorting one
 * table moving the other.
 *
 * Scope, stated once so the UI copy can rely on it:
 *
 * - This reorders **only the proposals already loaded**. The abstracts page
 *   reads a bounded newest-first page, and when it truncates it says so. Sorting
 *   does not reach past that page, and this module issues no query.
 * - It does not choose the decision round and does not change which reviews are
 *   included in a score. `weightedAverage` arrives already computed for the
 *   selected round; this only decides what order the rows appear in.
 *
 * The one rule that carries real weight: **a missing score is not a zero.**
 * "No included reviews" means nobody has finished a valid review yet, which is
 * a different fact from "reviewers scored this and it came out at the bottom".
 * Coercing it to 0 would file every unreviewed proposal below every reviewed
 * one on an ascending sort, and an organizer scanning for weak submissions
 * would find unreviewed ones instead.
 */

export type DecisionSortDirection = "asc" | "desc";

/** `null` is the untouched table: the server's newest-first page order. */
export type DecisionScoreSortState = { direction: DecisionSortDirection } | null;

export type DecisionScoreSortRow = {
  id: string;
  title: string;
  /**
   * The selected round's weighted average, or `null` when the proposal has no
   * included reviews. Never substitute a number for the absence.
   */
  weightedAverage: number | null;
};

/**
 * True when this row has no score to sort by.
 *
 * Non-finite guards the same case the display formatter does: a NaN or Infinity
 * arriving from an aggregate is an absent score, not an extreme one, and would
 * otherwise make the comparator non-transitive and the sort order arbitrary.
 */
export function decisionScoreMissing(value: number | null | undefined): boolean {
  return typeof value !== "number" || !Number.isFinite(value);
}

function compareText(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Proposal title, then stable id — ascending in **both** directions, so
 * flipping the sort never reshuffles rows that share a score, and the block of
 * unscored rows at the bottom keeps one predictable order.
 */
function tiebreak(a: DecisionScoreSortRow, b: DecisionScoreSortRow): number {
  if (a.title !== b.title) {
    const byTitle = compareText(a.title, b.title);
    if (byTitle !== 0) return byTitle;
  }
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Reorder the loaded rows by weighted decision score. Returns a new array.
 *
 * With `state === null` the server's order is returned untouched.
 */
export function sortByDecisionScore<T extends DecisionScoreSortRow>(
  rows: readonly T[],
  state: DecisionScoreSortState,
): T[] {
  if (state === null) return [...rows];
  const factor = state.direction === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const aMissing = decisionScoreMissing(a.weightedAverage);
    const bMissing = decisionScoreMissing(b.weightedAverage);
    // Direction-independent, and checked before the numeric compare so an
    // absent score is never read as a value at either end of the range.
    if (aMissing && bMissing) return tiebreak(a, b);
    if (aMissing !== bMissing) return aMissing ? 1 : -1;
    // Both present: a numeric comparison, never a comparison of the two-decimal
    // strings the cell renders (which would put "10.00" before "9.50").
    const byScore = (a.weightedAverage as number) - (b.weightedAverage as number);
    return byScore !== 0 ? byScore * factor : tiebreak(a, b);
  });
}

/**
 * The state a click on the decision-score header produces.
 *
 * Opens on **descending**: the question this column exists to answer is "which
 * proposals scored highest", so the first click should show the top of the
 * field rather than the bottom.
 */
export function nextDecisionScoreSort(state: DecisionScoreSortState): DecisionScoreSortState {
  if (state === null) return { direction: "desc" };
  return { direction: state.direction === "desc" ? "asc" : "desc" };
}

/** `aria-sort` for the decision-score header, or `undefined` while unsorted. */
export function decisionScoreAriaSort(
  state: DecisionScoreSortState,
): "ascending" | "descending" | undefined {
  if (state === null) return undefined;
  return state.direction === "asc" ? "ascending" : "descending";
}
