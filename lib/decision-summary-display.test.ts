import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDecisionScore } from "./decision-summary-display";

test("decision-score display keeps finite values and withholds null or non-finite aggregates", () => {
  assert.equal(formatDecisionScore(3.5), "3.50");
  assert.equal(formatDecisionScore(null), null);
  assert.equal(formatDecisionScore(Number.NaN), null);
  assert.equal(formatDecisionScore(Number.POSITIVE_INFINITY), null);
});
