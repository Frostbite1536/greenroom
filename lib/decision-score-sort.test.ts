import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decisionScoreAriaSort,
  decisionScoreMissing,
  nextDecisionScoreSort,
  sortByDecisionScore,
  type DecisionScoreSortRow,
} from "./decision-score-sort";
import { formatDecisionScore } from "./decision-summary-display";

const row = (id: string, weightedAverage: number | null, title = `Proposal ${id}`): DecisionScoreSortRow =>
  ({ id, title, weightedAverage });

const ids = (rows: readonly DecisionScoreSortRow[]) => rows.map((r) => r.id);

// ---- default state ---------------------------------------------------------

test("the untouched table keeps the server's newest-first page order", () => {
  const rows = [row("c", 2), row("a", 5), row("b", null)];
  assert.deepEqual(ids(sortByDecisionScore(rows, null)), ["c", "a", "b"]);
  assert.notEqual(sortByDecisionScore(rows, null), rows);
  assert.deepEqual(ids(rows), ["c", "a", "b"], "input must not be mutated");
  assert.equal(decisionScoreAriaSort(null), undefined);
});

// ---- both directions -------------------------------------------------------

test("weighted scores sort ascending and descending", () => {
  const rows = [row("mid", 3.5), row("low", 1.25), row("high", 4.75)];
  assert.deepEqual(ids(sortByDecisionScore(rows, { direction: "asc" })), ["low", "mid", "high"]);
  assert.deepEqual(ids(sortByDecisionScore(rows, { direction: "desc" })), ["high", "mid", "low"]);
});

test("the first click shows the top of the field, and clicks alternate from there", () => {
  const first = nextDecisionScoreSort(null);
  assert.deepEqual(first, { direction: "desc" });
  const second = nextDecisionScoreSort(first);
  assert.deepEqual(second, { direction: "asc" });
  assert.deepEqual(nextDecisionScoreSort(second), { direction: "desc" });
  assert.equal(decisionScoreAriaSort(first), "descending");
  assert.equal(decisionScoreAriaSort(second), "ascending");
});

test("a direction round trip returns the same order", () => {
  const rows = [row("b", 2), row("a", 9), row("c", null), row("d", 2)];
  const descending = nextDecisionScoreSort(null);
  const first = ids(sortByDecisionScore(rows, descending));
  const there = nextDecisionScoreSort(descending);
  const back = nextDecisionScoreSort(there);
  assert.notDeepEqual(ids(sortByDecisionScore(rows, there)), first);
  assert.deepEqual(ids(sortByDecisionScore(rows, back)), first);
});

// ---- missing scores --------------------------------------------------------

test("a missing score sorts LAST in both directions and is never read as zero", () => {
  const rows = [
    row("none", null),
    row("negative", -1),
    row("zero", 0),
    row("high", 8),
  ];
  // If null were coerced to 0 it would land beside "zero" — ahead of the
  // genuinely lowest-scored proposal — and an organizer scanning for weak
  // submissions would be shown an unreviewed one instead.
  assert.deepEqual(
    ids(sortByDecisionScore(rows, { direction: "asc" })),
    ["negative", "zero", "high", "none"],
  );
  assert.deepEqual(
    ids(sortByDecisionScore(rows, { direction: "desc" })),
    ["high", "zero", "negative", "none"],
  );
});

test("NaN and Infinity count as absent, not as extremes", () => {
  assert.equal(decisionScoreMissing(null), true);
  assert.equal(decisionScoreMissing(undefined), true);
  assert.equal(decisionScoreMissing(Number.NaN), true);
  assert.equal(decisionScoreMissing(Number.POSITIVE_INFINITY), true);
  assert.equal(decisionScoreMissing(Number.NEGATIVE_INFINITY), true);
  assert.equal(decisionScoreMissing(0), false);

  const rows = [row("nan", Number.NaN), row("inf", Number.POSITIVE_INFINITY), row("real", 3)];
  assert.deepEqual(ids(sortByDecisionScore(rows, { direction: "desc" })), ["real", "inf", "nan"]);
  assert.deepEqual(ids(sortByDecisionScore(rows, { direction: "asc" })), ["real", "inf", "nan"]);
  // The same values the display formatter refuses to print are the ones the
  // comparator treats as absent, so the cell and the order agree.
  assert.equal(formatDecisionScore(Number.NaN), null);
  assert.equal(formatDecisionScore(Number.POSITIVE_INFINITY), null);
});

test("several unscored proposals keep a stable, predictable block", () => {
  const rows = [
    row("z", null, "Zebra"),
    row("a", null, "apple"),
    row("m", null, "Apple"),
    row("s", 4, "Scored"),
  ];
  // Case-insensitive title, then id: apple/Apple tie and "a" precedes "m".
  assert.deepEqual(ids(sortByDecisionScore(rows, { direction: "asc" })), ["s", "a", "m", "z"]);
  assert.deepEqual(ids(sortByDecisionScore(rows, { direction: "desc" })), ["s", "a", "m", "z"]);
});

// ---- numeric, not textual --------------------------------------------------

test("scores are compared as numbers, never as the strings the cell renders", () => {
  // Rendered these read "10.00", "9.50", "2.00". Sorting those descending as
  // text gives 9.50, 2.00, 10.00 — the bug this comparator avoids.
  const rows = [row("ten", 10), row("nine", 9.5), row("two", 2)];
  const descending = sortByDecisionScore(rows, { direction: "desc" });
  assert.deepEqual(ids(descending), ["ten", "nine", "two"]);

  const asText = [...rows].sort((a, b) =>
    String(formatDecisionScore(b.weightedAverage)).localeCompare(String(formatDecisionScore(a.weightedAverage))),
  );
  assert.notDeepEqual(ids(asText), ids(descending));
  assert.equal(formatDecisionScore(10), "10.00");
  assert.equal(formatDecisionScore(9.5), "9.50");
});

test("equal scores fall through to title then id, the same way in both directions", () => {
  const rows = [
    row("2", 4.25, "Bravo"),
    row("1", 4.25, "bravo"),
    row("3", 4.25, "Alpha"),
  ];
  assert.deepEqual(ids(sortByDecisionScore(rows, { direction: "asc" })), ["3", "1", "2"]);
  assert.deepEqual(ids(sortByDecisionScore(rows, { direction: "desc" })), ["3", "1", "2"]);
});

// ---- independence from the coverage table ----------------------------------

test("this module shares nothing with the review-coverage sort", async () => {
  const coverage = await import("./review-coverage-sort");
  const decision = await import("./decision-score-sort");
  // No re-export, no shared comparator identity: the two surfaces must be able
  // to change independently.
  const coverageExports: unknown[] = Object.values(coverage);
  for (const value of Object.values(decision) as unknown[]) {
    assert.equal(coverageExports.includes(value), false);
  }
  // And the state shapes are not interchangeable: coverage carries a column,
  // this one does not.
  assert.deepEqual(Object.keys(nextDecisionScoreSort(null) ?? {}), ["direction"]);
  assert.deepEqual(
    Object.keys(coverage.nextCoverageSort(null, "status") ?? {}).sort(),
    ["column", "direction"],
  );
});
