import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COVERAGE_STATUS_ORDER,
  coverageAriaSort,
  coverageStatusRank,
  nextCoverageSort,
  sortCoverageRows,
  type CoverageSortColumn,
  type CoverageSortRow,
} from "./review-coverage-sort";
import { EVALUATION_SETUP_STATUS_LABELS } from "./evaluation-setup-status";

const row = (over: Partial<CoverageSortRow> & { id: string }): CoverageSortRow => ({
  title: `Proposal ${over.id}`,
  categoryName: "Platform",
  status: "SUBMITTED",
  assigned: 0,
  completed: 0,
  ...over,
});

const ids = (rows: readonly CoverageSortRow[]) => rows.map((r) => r.id);

// ---- default state ---------------------------------------------------------

test("the untouched table keeps the server's own order", () => {
  const rows = [row({ id: "c" }), row({ id: "a" }), row({ id: "b" })];
  assert.deepEqual(ids(sortCoverageRows(rows, null)), ["c", "a", "b"]);
  // A copy, never the caller's array.
  assert.notEqual(sortCoverageRows(rows, null), rows);
  assert.deepEqual(ids(rows), ["c", "a", "b"], "input must not be mutated");
  for (const column of ["proposal", "category", "status", "reviewers", "reviewsDone"] as const) {
    assert.equal(coverageAriaSort(null, column), undefined);
  }
});

// ---- proposal --------------------------------------------------------------

test("proposal sorts case-insensitively by title, then by stable id", () => {
  const rows = [
    row({ id: "3", title: "beta" }),
    row({ id: "1", title: "Alpha" }),
    row({ id: "2", title: "alpha" }),
  ];
  assert.deepEqual(
    ids(sortCoverageRows(rows, { column: "proposal", direction: "asc" })),
    ["1", "2", "3"],
    "Alpha and alpha are equal, so the id decides",
  );
  assert.deepEqual(
    ids(sortCoverageRows(rows, { column: "proposal", direction: "desc" })),
    ["3", "1", "2"],
    "the tied pair keeps its ascending id order inside the reversed list",
  );
});

// ---- category --------------------------------------------------------------

test("category sorts case-insensitively and keeps missing categories last in BOTH directions", () => {
  const rows = [
    row({ id: "1", title: "One", categoryName: null }),
    row({ id: "2", title: "Two", categoryName: "zeta" }),
    row({ id: "3", title: "Three", categoryName: "Alpha" }),
    row({ id: "4", title: "Four", categoryName: "   " }),
  ];
  assert.deepEqual(
    ids(sortCoverageRows(rows, { column: "category", direction: "asc" })),
    ["3", "2", "4", "1"],
    "Alpha, zeta, then the two absent ones by title (Four, One)",
  );
  assert.deepEqual(
    ids(sortCoverageRows(rows, { column: "category", direction: "desc" })),
    ["2", "3", "4", "1"],
    "reversing the names must not promote the blanks to the top",
  );
});

test("equal categories fall through to title then id", () => {
  const rows = [
    row({ id: "b", title: "Same", categoryName: "Platform" }),
    row({ id: "a", title: "Same", categoryName: "platform" }),
    row({ id: "c", title: "Another", categoryName: "PLATFORM" }),
  ];
  assert.deepEqual(ids(sortCoverageRows(rows, { column: "category", direction: "asc" })), ["c", "a", "b"]);
});

// ---- status ----------------------------------------------------------------

test("status uses the review pipeline order, not the enum or the display labels", () => {
  const rows = [
    row({ id: "w", title: "W", status: "WITHDRAWN" }),
    row({ id: "s", title: "S", status: "SUBMITTED" }),
    row({ id: "a", title: "A", status: "ACCEPTED" }),
    row({ id: "u", title: "U", status: "UNDER_REVIEW" }),
    row({ id: "r", title: "R", status: "REJECTED" }),
    row({ id: "m", title: "M", status: "MAYBE" }),
  ];
  assert.deepEqual(
    ids(sortCoverageRows(rows, { column: "status", direction: "asc" })),
    ["s", "u", "m", "a", "r", "w"],
  );
  assert.deepEqual(
    ids(sortCoverageRows(rows, { column: "status", direction: "desc" })),
    ["w", "r", "a", "m", "u", "s"],
  );

  // Alphabetical display order would be Accepted, Declined, Maybe, Submitted,
  // Under review, Withdrawn — a different and meaningless sequence. Pinning it
  // here so nobody "simplifies" the rank into a label sort.
  const byLabel = [...rows].sort((x, y) =>
    EVALUATION_SETUP_STATUS_LABELS[x.status as keyof typeof EVALUATION_SETUP_STATUS_LABELS]
      .localeCompare(EVALUATION_SETUP_STATUS_LABELS[y.status as keyof typeof EVALUATION_SETUP_STATUS_LABELS]),
  );
  assert.notDeepEqual(ids(byLabel), ["s", "u", "m", "a", "r", "w"]);
});

test("an unrecognised status is placed last rather than ranked first", () => {
  assert.equal(coverageStatusRank("SOMETHING_NEW"), COVERAGE_STATUS_ORDER.length);
  const rows = [row({ id: "x", title: "X", status: "FUTURE" }), row({ id: "s", title: "S", status: "SUBMITTED" })];
  assert.deepEqual(ids(sortCoverageRows(rows, { column: "status", direction: "asc" })), ["s", "x"]);
});

// ---- reviewers and reviews done -------------------------------------------

test("reviewers sorts by the assigned count as a number, then title and id", () => {
  const rows = [
    row({ id: "1", title: "B", assigned: 10 }),
    row({ id: "2", title: "A", assigned: 2 }),
    row({ id: "3", title: "C", assigned: 2 }),
  ];
  assert.deepEqual(ids(sortCoverageRows(rows, { column: "reviewers", direction: "asc" })), ["2", "3", "1"]);
  assert.deepEqual(ids(sortCoverageRows(rows, { column: "reviewers", direction: "desc" })), ["1", "2", "3"]);
});

test("reviews done never sorts the rendered fraction as text", () => {
  // Rendered these read "2/10", "10/20", "3/4". A lexicographic sort of those
  // strings gives 10/20 < 2/10 < 3/4 — the exact bug this comparator avoids.
  const rows = [
    row({ id: "a", title: "A", completed: 2, assigned: 10 }),
    row({ id: "b", title: "B", completed: 10, assigned: 20 }),
    row({ id: "c", title: "C", completed: 3, assigned: 4 }),
  ];
  const ascending = sortCoverageRows(rows, { column: "reviewsDone", direction: "asc" });
  assert.deepEqual(ids(ascending), ["a", "c", "b"]);
  const lexicographic = [...rows]
    .sort((x, y) => `${x.completed}/${x.assigned}`.localeCompare(`${y.completed}/${y.assigned}`));
  assert.notDeepEqual(ids(lexicographic), ids(ascending));

  assert.deepEqual(ids(sortCoverageRows(rows, { column: "reviewsDone", direction: "desc" })), ["b", "c", "a"]);
});

test("equal completed counts are separated by the assigned count", () => {
  const rows = [
    row({ id: "big", title: "Big", completed: 2, assigned: 30 }),
    row({ id: "small", title: "Small", completed: 2, assigned: 3 }),
  ];
  // 2 of 3 is further along than 2 of 30.
  assert.deepEqual(ids(sortCoverageRows(rows, { column: "reviewsDone", direction: "asc" })), ["small", "big"]);
  assert.deepEqual(ids(sortCoverageRows(rows, { column: "reviewsDone", direction: "desc" })), ["big", "small"]);
});

// ---- direction changes and aria-sort ---------------------------------------

test("a click opens ascending, and the active column flips", () => {
  const first = nextCoverageSort(null, "status");
  assert.deepEqual(first, { column: "status", direction: "asc" });
  const second = nextCoverageSort(first, "status");
  assert.deepEqual(second, { column: "status", direction: "desc" });
  assert.deepEqual(nextCoverageSort(second, "status"), { column: "status", direction: "asc" });
  // A different column always opens ascending, never inheriting the flip.
  assert.deepEqual(nextCoverageSort(second, "category"), { column: "category", direction: "asc" });
});

test("aria-sort marks only the active header, and a round trip restores the order", () => {
  const columns: CoverageSortColumn[] = ["proposal", "category", "status", "reviewers", "reviewsDone"];
  const active = nextCoverageSort(null, "reviewers");
  assert.equal(coverageAriaSort(active, "reviewers"), "ascending");
  assert.equal(
    columns.filter((c) => coverageAriaSort(active, c) !== undefined).length,
    1,
    "exactly one header may claim aria-sort",
  );
  const flipped = nextCoverageSort(active, "reviewers");
  assert.equal(coverageAriaSort(flipped, "reviewers"), "descending");

  const rows = [
    row({ id: "1", title: "B", assigned: 3 }),
    row({ id: "2", title: "A", assigned: 1 }),
    row({ id: "3", title: "C", assigned: 2 }),
  ];
  const ascending = ids(sortCoverageRows(rows, active));
  const descending = ids(sortCoverageRows(rows, flipped));
  assert.notDeepEqual(ascending, descending);
  // asc -> desc -> asc lands back on the same order, and never on the raw
  // server order by accident.
  assert.deepEqual(ids(sortCoverageRows(rows, nextCoverageSort(flipped, "reviewers"))), ascending);
  assert.deepEqual(ascending, ["2", "3", "1"]);
});
