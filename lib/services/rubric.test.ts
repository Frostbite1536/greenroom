import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRubric, validateScores, weightedScore } from "@/lib/services/rubric";

const rubric = parseRubric([
  { key: "relevance", label: "Relevance", min: 1, max: 5, weight: 2 },
  { key: "clarity", label: "Clarity", min: 0, max: 10, weight: 1 },
]);

test("parseRubric keeps valid criteria and drops junk", () => {
  assert.equal(rubric.length, 2);
  assert.equal(parseRubric("nope").length, 0);
  assert.equal(parseRubric([{ key: "x" }]).length, 0);
});

test("valid scores pass", () => {
  const err = validateScores(rubric, [
    { rubricKey: "relevance", score: 4 },
    { rubricKey: "clarity", score: 9 },
  ]);
  assert.equal(err, null);
});

test("unknown rubric key is rejected", () => {
  const err = validateScores(rubric, [{ rubricKey: "ghost", score: 1 }]);
  assert.equal(err?.code, "INVALID_SCORES");
  assert.ok(err?.fieldErrors?.ghost);
});

test("out-of-range score is rejected", () => {
  const err = validateScores(rubric, [{ rubricKey: "relevance", score: 6 }]);
  assert.ok(err?.fieldErrors?.relevance);
});

test("weightedScore respects weights", () => {
  const value = weightedScore(rubric, { relevance: 5, clarity: 2 });
  assert.equal(value, (5 * 2 + 2 * 1) / 3);
});
