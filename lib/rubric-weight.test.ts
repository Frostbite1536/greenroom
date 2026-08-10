import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RUBRIC_RANGE_WARNING,
  RUBRIC_WEIGHT_MAX,
  isValidRubricWeight,
  parseRubricWeight,
  rubricRangeWarning,
  rubricRangesDiffer,
  rubricWeightError,
  rubricWeightShare,
  rubricWeightShareLine,
} from "./rubric-weight";
import { weightedScore, type RubricCriterion } from "./services/rubric";

/** The seven weight test classes required by D-C5-8 §2.5. */

// ---- 1. proportional scale invariance --------------------------------------

test("scaling every weight by the same constant does not change the score", () => {
  const scores = { relevance: 5, originality: 3, clarity: 4 };
  const build = (weights: [number, number, number]): RubricCriterion[] => [
    { key: "relevance", label: "Relevance", min: 1, max: 5, weight: weights[0] },
    { key: "originality", label: "Originality", min: 1, max: 5, weight: weights[1] },
    { key: "clarity", label: "Clarity", min: 1, max: 5, weight: weights[2] },
  ];

  const ratio = weightedScore(build([2, 1, 1]), scores);
  // The two rubrics named in §2.1. If these ever diverge the formula has been
  // changed from a weighted average into something percentage-shaped.
  assert.equal(weightedScore(build([50, 25, 25]), scores), ratio);
  assert.equal(weightedScore(build([0.2, 0.1, 0.1]), scores), ratio);
  assert.equal(ratio, (5 * 2 + 3 + 4) / 4);

  // And the *shares* are identical too, which is what the editor prints.
  assert.equal(rubricWeightShare(2, [2, 1, 1]), 50);
  assert.equal(rubricWeightShare(50, [50, 25, 25]), 50);
});

// ---- 2. decimal weights -----------------------------------------------------

test("decimal weights are valid and carry their real share", () => {
  assert.equal(parseRubricWeight("1.5"), 1.5);
  assert.equal(rubricWeightError("1.5"), null);
  assert.equal(rubricWeightError("0.001"), null);
  assert.equal(isValidRubricWeight(0.5), true);
  // 1.5 against a 4.5 total is a third, printed to one decimal.
  assert.equal(
    rubricWeightShareLine("1.5", ["1.5", "1", "1", "1"]),
    "Weight 1.5 · 33.3% of rubric weight",
  );
});

// ---- 3. zero, negative, non-finite and over-limit rejection ----------------

test("zero, negative, non-finite and over-limit weights are refused, never coerced", () => {
  // The bug this replaces: `Number(value) || 1` read every one of these as 1.
  assert.equal(parseRubricWeight(""), null);
  assert.equal(parseRubricWeight("   "), null);
  assert.equal(parseRubricWeight("abc"), null);
  assert.equal(parseRubricWeight("Infinity"), null);
  assert.equal(parseRubricWeight("0"), 0, "a typed zero survives parsing so it can be reported");

  assert.equal(rubricWeightError(""), "Enter a weight greater than 0.");
  assert.equal(rubricWeightError("abc"), "Weight must be a number.");
  assert.equal(rubricWeightError("0"), "Weight must be greater than 0.");
  assert.equal(rubricWeightError("-3"), "Weight must be greater than 0.");
  assert.equal(rubricWeightError("Infinity"), "Weight must be a number.");
  assert.equal(rubricWeightError("101"), "Weight must be 100 or less.");
  assert.equal(rubricWeightError(String(RUBRIC_WEIGHT_MAX)), null, "the limit itself is allowed");

  assert.equal(isValidRubricWeight(0), false);
  assert.equal(isValidRubricWeight(-1), false);
  assert.equal(isValidRubricWeight(Number.POSITIVE_INFINITY), false);
  assert.equal(isValidRubricWeight(Number.NaN), false);
  assert.equal(isValidRubricWeight(null), false);
  assert.equal(isValidRubricWeight(RUBRIC_WEIGHT_MAX + 0.1), false);

  // An unusable draft has no share at all — printing 0% would read as
  // "this criterion is ignored", which is a different and untrue claim.
  assert.equal(rubricWeightShareLine("0", ["0", "1"]), null);
  assert.equal(rubricWeightShareLine("", ["", "1"]), null);
  assert.equal(rubricWeightShare(1, []), null);
  assert.equal(rubricWeightShare(1, [0, -2]), null);
});

// ---- 4. normalized weight-share display ------------------------------------

test("the share line names the weight and its normalized share, in the agreed wording", () => {
  assert.equal(
    rubricWeightShareLine("2", ["2", "1", "1"]),
    "Weight 2 · 50% of rubric weight",
  );
  assert.equal(
    rubricWeightShareLine("1", ["2", "1", "1"]),
    "Weight 1 · 25% of rubric weight",
  );
  // A lone criterion is the entire rubric.
  assert.equal(rubricWeightShareLine("7", ["7"]), "Weight 7 · 100% of rubric weight");
  // Invalid siblings are excluded from the denominator rather than counted as
  // zero-weight members, so the visible shares always describe what will save.
  assert.equal(rubricWeightShareLine("1", ["1", "1", ""]), "Weight 1 · 50% of rubric weight");
});

// ---- 5. totals below, equal to and above 100 all remain valid ---------------

test("the rubric total is never a validity target", () => {
  const below = ["1", "1", "1"];
  const equal = ["50", "25", "25"];
  const above = ["100", "100", "100"];

  for (const rubric of [below, equal, above]) {
    for (const weight of rubric) {
      assert.equal(rubricWeightError(weight), null, `${weight} in [${rubric}] should be valid`);
    }
  }

  assert.equal(rubricWeightShareLine("1", below), "Weight 1 · 33.3% of rubric weight");
  assert.equal(rubricWeightShareLine("50", equal), "Weight 50 · 50% of rubric weight");
  assert.equal(rubricWeightShareLine("100", above), "Weight 100 · 33.3% of rubric weight");
});

// ---- 6/7. the different-ranges warning, present and absent ------------------

test("differing score ranges raise the visible non-blocking warning", () => {
  assert.equal(rubricRangesDiffer([{ min: 1, max: 5 }, { min: 0, max: 10 }]), true);
  assert.equal(
    rubricRangeWarning([{ min: 1, max: 5 }, { min: 0, max: 10 }]),
    RUBRIC_RANGE_WARNING,
  );
  // A differing lower bound alone is enough: 1–5 and 0–5 are not the same scale.
  assert.equal(rubricRangesDiffer([{ min: 1, max: 5 }, { min: 0, max: 5 }]), true);
  assert.match(RUBRIC_RANGE_WARNING, /^Criteria use different score ranges\./);
  assert.match(RUBRIC_RANGE_WARNING, /wider ranges can have more effect on the result\.$/);
});

test("consistent ranges raise no warning, and neither does a half-typed one", () => {
  assert.equal(rubricRangesDiffer([{ min: 1, max: 5 }, { min: 1, max: 5 }, { min: 1, max: 5 }]), false);
  assert.equal(rubricRangeWarning([{ min: 1, max: 5 }, { min: 1, max: 5 }]), null);
  // One criterion cannot disagree with itself.
  assert.equal(rubricRangeWarning([{ min: 0, max: 10 }]), null);
  assert.equal(rubricRangeWarning([]), null);
  // Mid-edit garbage is an authoring state, not a range disagreement: warning
  // on every keystroke would train the author to ignore it.
  assert.equal(rubricRangeWarning([{ min: 1, max: 5 }, { min: 5, max: 5 }]), null);
  assert.equal(rubricRangeWarning([{ min: 1, max: 5 }, { min: Number.NaN, max: 10 }]), null);
});

// ---- the scoring formula itself is untouched --------------------------------

test("nothing here changes how a completed review is scored", () => {
  const rubric: RubricCriterion[] = [
    { key: "a", label: "A", min: 1, max: 5, weight: 3 },
    { key: "b", label: "B", min: 0, max: 10, weight: 1 },
  ];
  // Raw scores are averaged by weight — the 0-10 criterion is NOT rescaled.
  // That is exactly the behaviour the §2.3 warning exists to disclose.
  assert.equal(weightedScore(rubric, { a: 4, b: 10 }), (4 * 3 + 10) / 4);
  // A criterion with no score contributes neither value nor weight.
  assert.equal(weightedScore(rubric, { a: 4 }), 4);
});
