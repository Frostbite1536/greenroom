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

/**
 * Trim a computed number to at most one decimal, without a trailing `.0`.
 *
 * Exported so the read-only rubric view (`lib/rubric-display.ts`) prints a
 * weight and a share exactly as the round editor does. Two formatters would
 * eventually disagree over a value like `33.333…`.
 */
export function formatRubricWeightNumber(value: number): string {
  return String(Math.round(value * 10) / 10);
}

const formatWeightNumber = formatRubricWeightNumber;

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

// ---------------------------------------------------------------------------
// The ceiling as an AUTHORING rule, with honest grandfathering
// ---------------------------------------------------------------------------

/**
 * Why `RUBRIC_WEIGHT_MAX` is enforced here and not in `rubricCriterionSchema`:
 *
 * A plan authored before the ceiling existed can hold a criterion weighted
 * above it. That value is not bad input — it is the event's established scoring
 * configuration, and reviews have already been scored against it. Expressing
 * the ceiling as a value-level Zod rule punished exactly the wrong party twice:
 *
 * 1. `parseDecisionRubric` parses **stored** rubric JSON through that same
 *    schema and returns null for the whole rubric on any failure, so a legacy
 *    weight silently blanked that round's decision scores.
 * 2. Editing anything else about the round — its name, its window — resubmits
 *    the complete rubric, so the unchanged legacy weight was rejected and the
 *    admin could only save by altering established scoring weights.
 *
 * The rule that is actually wanted is about the *edit*, not the *value*: a
 * weight you are merely carrying forward is fine; a weight you are introducing
 * or changing must meet the ceiling. That needs the stored value for
 * comparison, which Zod does not have — hence a route-layer check over a fresh
 * server-side read. A client-supplied "this one is unchanged" flag would be
 * trivially forgeable and is never trusted.
 */
export type IncomingRubricWeight = { key: string; label?: string; weight: number };

/**
 * Weights already stored on a plan, by criterion key.
 *
 * Deliberately tolerant: this reads whatever is in the database, including
 * shapes a current write would refuse, because its only job is to answer "what
 * was this criterion's weight before this edit". Anything unreadable simply
 * fails to match, which denies the exception rather than granting it.
 */
export function readStoredRubricWeights(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const { key, weight } = record;
    if (typeof key !== "string" || typeof weight !== "number") continue;
    if (!Number.isFinite(weight)) continue;
    out.set(key, weight);
  }
  return out;
}

/**
 * Field errors for every incoming weight that breaks the ceiling *and* is not a
 * grandfathered carry-over, or `null` when the rubric may be saved.
 *
 * `storedRubric` must be the rubric as read from the database inside the same
 * transaction that will perform the write. Pass `null`/`undefined` when
 * creating: a brand-new plan has nothing to carry forward, so every weight
 * above the ceiling is refused.
 */
export function rubricWeightBoundErrors(
  incoming: readonly IncomingRubricWeight[],
  storedRubric: unknown,
): Record<string, string[]> | null {
  const stored = readStoredRubricWeights(storedRubric);
  const messages: string[] = [];
  for (const criterion of incoming) {
    if (criterion.weight <= RUBRIC_WEIGHT_MAX) continue;
    // Exact equality on the number: carrying 150 forward is allowed, nudging it
    // to 149 is not. "Changed" and "still above the ceiling" is a new choice.
    if (stored.get(criterion.key) === criterion.weight) continue;
    messages.push(
      `“${criterion.label ?? criterion.key}”: weight ${criterion.weight} is above the ${RUBRIC_WEIGHT_MAX} limit. `
        + `An existing weight above the limit can stay exactly as it is, but a new or changed weight must be ${RUBRIC_WEIGHT_MAX} or less.`,
    );
  }
  return messages.length > 0 ? { rubric: messages } : null;
}

/**
 * A gentle, admin-facing note for a stored rubric that predates the ceiling, or
 * `null` when every weight is within it.
 *
 * Deliberately not phrased as a problem: nothing is wrong with the round, and
 * nothing needs fixing. It exists so an admin who later hits the authoring
 * refusal already knows which criterion it is about.
 */
export function legacyRubricWeightNote(
  criteria: readonly { label: string; weight: number }[],
): string | null {
  const over = criteria.filter((c) => c.weight > RUBRIC_WEIGHT_MAX);
  if (over.length === 0) return null;
  const named = over.map((c) => `${c.label} (${c.weight})`).join(", ");
  return `${named} ${over.length === 1 ? "was" : "were"} set above the current ${RUBRIC_WEIGHT_MAX} weight limit and ${over.length === 1 ? "is" : "are"} kept as configured. Scoring is unaffected.`;
}
