/**
 * Sorting for the admin **review coverage** table (D-C5-8 §3.1).
 *
 * Deliberately a pure module with its own state type, kept independent of the
 * abstract decision table's sort (`lib/decision-score-sort.ts`). The two
 * surfaces answer different questions and share no comparator: coupling them
 * would mean a change to one silently reordering the other.
 *
 * The sort is **local to the rows already loaded**. Nothing here issues a query
 * or changes which proposals the server returned — it reorders what is on
 * screen, and the unsorted state is the server's own order.
 *
 * Two rules the table's cells force on the comparators:
 *
 * - "Reviews done" renders as `3/10`. Sorting that *string* would put `10/20`
 *   before `3/4`, so every comparator here comes off the underlying numbers.
 * - Status renders as "Under review", "Declined", "Withdrawn". Sorting by those
 *   labels, or by the enum's own declaration order, would be an arbitrary
 *   alphabet. `COVERAGE_STATUS_ORDER` is an explicit pipeline order instead.
 */

export type CoverageSortColumn =
  | "proposal"
  | "category"
  | "status"
  | "reviewers"
  | "reviewsDone";

export type SortDirection = "asc" | "desc";

/** `null` is the untouched table: the server's own order, before any choice. */
export type CoverageSortState = { column: CoverageSortColumn; direction: SortDirection } | null;

export type CoverageSortRow = {
  id: string;
  title: string;
  categoryName: string | null;
  status: string;
  /** Reviewers assigned in the selected round. */
  assigned: number;
  /** Completed reviews in the selected round. */
  completed: number;
};

/**
 * How far a proposal has travelled through review, earliest stage first.
 *
 * Not the Prisma enum order and not the display labels — this is the order an
 * organizer reads the pipeline in, so ascending walks new work down to work
 * that has left the queue. An unlisted status sorts last rather than at 0, so a
 * future status is visibly unplaced instead of silently ranked "newest".
 */
export const COVERAGE_STATUS_ORDER: readonly string[] = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "MAYBE",
  "ACCEPTED",
  "REJECTED",
  "WITHDRAWN",
];

export function coverageStatusRank(status: string): number {
  const index = COVERAGE_STATUS_ORDER.indexOf(status);
  return index === -1 ? COVERAGE_STATUS_ORDER.length : index;
}

/**
 * Case-insensitive text order.
 *
 * Lower-cased comparison rather than `localeCompare`, so the order does not
 * change with the runtime's locale or ICU build — the tests beside this file
 * would then pass on one machine and fail on another.
 */
function compareText(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareId(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** A category is missing when it is absent or blank, not when it sorts low. */
function categoryMissing(name: string | null): boolean {
  return name === null || name.trim() === "";
}

/**
 * The stable tail every column falls back to: proposal title, then id.
 *
 * Applied **ascending in both directions** on purpose. Reversing the tiebreak
 * too would mean flipping direction reshuffles rows that are equal under the
 * chosen column, which reads as data changing rather than as a re-sort.
 */
function tiebreak(a: CoverageSortRow, b: CoverageSortRow): number {
  return compareText(a.title, b.title) || compareId(a.id, b.id);
}

const PRIMARY: Record<CoverageSortColumn, (a: CoverageSortRow, b: CoverageSortRow) => number> = {
  // Stated explicitly rather than leaning on the shared tiebreak: the tiebreak
  // is deliberately direction-independent, so delegating to it would leave this
  // column stuck ascending however often the header is clicked.
  proposal: (a, b) => compareText(a.title, b.title),
  category: (a, b) => compareText(a.categoryName ?? "", b.categoryName ?? ""),
  status: (a, b) => coverageStatusRank(a.status) - coverageStatusRank(b.status),
  reviewers: (a, b) => a.assigned - b.assigned,
  // Assigned count is part of this column's key, not a tiebreak: "2 of 3 done"
  // is further along than "2 of 30", and descending should say so.
  reviewsDone: (a, b) => a.completed - b.completed || a.assigned - b.assigned,
};

/**
 * Reorder the loaded rows. Returns a new array; the input is never mutated.
 *
 * With `state === null` the server order is returned untouched.
 */
export function sortCoverageRows<T extends CoverageSortRow>(
  rows: readonly T[],
  state: CoverageSortState,
): T[] {
  if (state === null) return [...rows];
  const factor = state.direction === "desc" ? -1 : 1;
  const primary = PRIMARY[state.column];
  return [...rows].sort((a, b) => {
    if (state.column === "category") {
      // Direction-independent: an uncategorized proposal has no category, it
      // does not have the lowest one. Flipping direction must not promote the
      // blanks to the top of the table.
      const aMissing = categoryMissing(a.categoryName);
      const bMissing = categoryMissing(b.categoryName);
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
      // Both absent: there is no name to compare, and `"" vs "   "` would order
      // them by whitespace. Fall straight to the stable tail.
      if (aMissing) return tiebreak(a, b);
    }
    const byPrimary = primary(a, b);
    return byPrimary !== 0 ? byPrimary * factor : tiebreak(a, b);
  });
}

/**
 * The state a click on `column` produces.
 *
 * A new column opens ascending; the active column flips. There is no cycle back
 * to the server order — "unsorted" is the state the table starts in, and an
 * accidental third click landing back on an order nobody asked for is worse
 * than one extra click to get back to ascending.
 */
export function nextCoverageSort(
  state: CoverageSortState,
  column: CoverageSortColumn,
): CoverageSortState {
  if (state?.column === column) {
    return { column, direction: state.direction === "asc" ? "desc" : "asc" };
  }
  return { column, direction: "asc" };
}

/**
 * `aria-sort` for one header — `undefined` for every column but the active one.
 *
 * A table may expose exactly one sorted column, so an inactive header must
 * carry no attribute at all rather than `aria-sort="none"` on all five.
 */
export function coverageAriaSort(
  state: CoverageSortState,
  column: CoverageSortColumn,
): "ascending" | "descending" | undefined {
  if (state?.column !== column) return undefined;
  return state.direction === "asc" ? "ascending" : "descending";
}
