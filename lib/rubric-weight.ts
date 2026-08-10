/**
 * Rubric weight semantics for the review-round editor (D-C5-8 §2).
 *
 * Greenroom scores a completed review as
 * `sum(score × weight) / sum(weights)`, so a weight is a **relative
 * multiplier, not a percentage**: `2, 1, 1` and `50, 25, 25` produce the same
 * result. Nothing here changes that formula, and nothing here rewrites a
 * stored score — this module only decides what the author is told and which
 * drafts are refused before they reach the plans API.
 *
 * Two consequences the editor has to state out loud:
 *
 * 1. Because weights are relative, their sum is **not** a validity target. A
 *    rubric totalling 3, 100 or 450 is equally valid, so this module offers no
 *    "should add up to 100" check and the UI must not warn about the total.
 *    What an author actually wants to see is each criterion's *share* of the
 *    total — `Weight 2 · 50% of rubric weight` — which is true whether they
 *    think in ratios or in percentages.
 * 2. Because the formula averages **raw** scores, equal weights do not imply
 *    equal possible effect when criteria use different ranges: a 0–10
 *    criterion can move the result further than a 1–5 one. That is surfaced as
 *    a visible, non-blocking warning rather than silently normalized — range
 *    normalization would be a different scoring contract and would change
 *    historical results.
 *
 * The bounds below are the *shared* client/server contract: `types/api.ts`
 * imports `RUBRIC_WEIGHT_MAX` so the dialog and `rubricCriterionSchema` cannot
 * drift apart.
 */

/**
 * Input-safety ceiling for a single criterion weight.
 *
 * Deliberately NOT a statement that a rubric totals 100 — it only stops a
 * mistyped `1000000` from making every other criterion's share round to 0%.
 */
export const RUBRIC_WEIGHT_MAX = 100;

/** §2.3 warning copy, verbatim. Non-blocking: it never refuses a save. */
export const RUBRIC_RANGE_WARNING =
  "Criteria use different score ranges. Greenroom averages raw scores, so wider ranges can have more effect on the result.";

/**
 * Read a weight out of the raw text an author is holding mid-edit.
 *
 * Returns `null` for blank or unparseable input **instead of a fallback
 * number**. The old editor did `Number(value) || 1`, which turned an emptied
 * field and a typed `0` into a silent weight of 1 — an invisible edit to how
 * every future review is scored. A draft that cannot be read is reported, not
 * repaired.
 */
export function parseRubricWeight(draft: string): number | null {
  const trimmed = draft.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** Finite, greater than zero, at most `RUBRIC_WEIGHT_MAX`. Decimals are fine. */
export function isValidRubricWeight(value: number | null | undefined): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= RUBRIC_WEIGHT_MAX
  );
}

/**
 * Why this draft weight cannot be saved, or `null` when it is usable.
 *
 * Every branch is a message the author can act on; none of them is a coercion.
 */
export function rubricWeightError(draft: string): string | null {
  const trimmed = draft.trim();
  if (trimmed === "") return "Enter a weight greater than 0.";
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return "Weight must be a number.";
  if (value <= 0) return "Weight must be greater than 0.";
  if (value > RUBRIC_WEIGHT_MAX) return `Weight must be ${RUBRIC_WEIGHT_MAX} or less.`;
  return null;
}

/**
 * This criterion's percentage share of the rubric's total weight.
 *
 * `null` when the share is undefined rather than zero — an invalid weight or a
 * rubric with no usable weight at all has no share, and printing `0%` there
 * would read as "this criterion is ignored".
 */
export function rubricWeightShare(
  weight: number | null | undefined,
  weights: readonly (number | null | undefined)[],
): number | null {
  if (!isValidRubricWeight(weight)) return null;
  let total = 0;
  for (const other of weights) if (isValidRubricWeight(other)) total += other;
  if (!(total > 0)) return null;
  return (weight / total) * 100;
}

/** Trim a computed number to at most one decimal, without a trailing `.0`. */
function formatWeightNumber(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/**
 * The share line under a weight input: `Weight 2 · 50% of rubric weight`.
 *
 * Returns `null` while the draft is unusable, so the caller shows the
 * validation message in that slot instead of a misleading percentage.
 */
export function rubricWeightShareLine(
  draft: string,
  allDrafts: readonly string[],
): string | null {
  const weight = parseRubricWeight(draft);
  const share = rubricWeightShare(
    weight,
    allDrafts.map((other) => parseRubricWeight(other)),
  );
  if (weight === null || share === null) return null;
  return `Weight ${formatWeightNumber(weight)} · ${formatWeightNumber(share)}% of rubric weight`;
}

export type RubricScoreRange = { min: number; max: number };

/**
 * True when the authored criteria do not all share one score range.
 *
 * Only ranges that could actually be saved are compared (`min < max`, both
 * finite): a half-typed range is an authoring state, not a disagreement, and
 * flashing the warning at every keystroke would train the author to ignore it.
 * A single criterion can never disagree with itself.
 */
export function rubricRangesDiffer(criteria: readonly RubricScoreRange[]): boolean {
  const usable = criteria.filter(
    (c) => Number.isFinite(c.min) && Number.isFinite(c.max) && c.min < c.max,
  );
  if (usable.length < 2) return false;
  const first = usable[0];
  return usable.some((c) => c.min !== first.min || c.max !== first.max);
}

/** The §2.3 warning when ranges differ, or `null` when they are consistent. */
export function rubricRangeWarning(criteria: readonly RubricScoreRange[]): string | null {
  return rubricRangesDiffer(criteria) ? RUBRIC_RANGE_WARNING : null;
}
