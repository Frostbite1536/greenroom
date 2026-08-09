import assert from "node:assert/strict";
import test from "node:test";
import { rubricKeyFromLabel, uniqueRubricKeys } from "./rubric-key";

/** Mirrors rubricCriterionSchema in types/api.ts. */
const VALID = /^[a-z][a-z0-9_]*$/;

test("ordinary labels become readable keys", () => {
  assert.equal(rubricKeyFromLabel("Relevance", 0), "relevance");
  assert.equal(rubricKeyFromLabel("Speaker Readiness", 0), "speaker_readiness");
  assert.equal(rubricKeyFromLabel("Fit for the audience & theme", 0), "fit_for_the_audience_theme");
});

test("accents are folded rather than stripped to nothing", () => {
  assert.equal(rubricKeyFromLabel("Clarté", 0), "clarte");
});

test("leading digits and symbols are dropped to satisfy the schema", () => {
  assert.equal(rubricKeyFromLabel("1st impression", 0), "st_impression");
  assert.equal(rubricKeyFromLabel("  ...Clarity", 0), "clarity");
});

test("labels with no usable characters fall back to a positional key", () => {
  for (const label of ["", "   ", "123", "!!!", "\u4e2d\u6587"]) {
    const key = rubricKeyFromLabel(label, 2);
    assert.equal(key, "criterion_3", `for ${JSON.stringify(label)}`);
  }
});

test("every derived key satisfies the schema pattern", () => {
  const labels = ["Relevance", "1st", "", "Clarté!!", "a".repeat(200), "___x___", "9lives"];
  for (const [i, label] of labels.entries()) {
    assert.ok(VALID.test(rubricKeyFromLabel(label, i)), `invalid key for ${JSON.stringify(label)}`);
  }
});

test("a long label is truncated without a trailing underscore", () => {
  const key = rubricKeyFromLabel(`${"word ".repeat(40)}`, 0);
  assert.ok(VALID.test(key), key);
  assert.ok(key.length <= 60);
  assert.ok(!key.endsWith("_"));
});

test("duplicate labels get distinct keys instead of collapsing", () => {
  // Two criteria sharing a key would overwrite one another's scores.
  assert.deepEqual(uniqueRubricKeys(["Clarity", "Clarity", "Clarity"]), [
    "clarity",
    "clarity_2",
    "clarity_3",
  ]);
});

test("de-duplication does not collide with an existing explicit suffix", () => {
  assert.deepEqual(uniqueRubricKeys(["Clarity", "Clarity 2", "Clarity"]), [
    "clarity",
    "clarity_2",
    "clarity_3",
  ]);
});

test("unnamed criteria stay unique via their positional fallback", () => {
  const keys = uniqueRubricKeys(["", "", ""]);
  assert.equal(new Set(keys).size, 3);
  for (const key of keys) assert.ok(VALID.test(key), key);
});
