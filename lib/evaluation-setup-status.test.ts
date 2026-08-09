import assert from "node:assert/strict";
import test from "node:test";
import {
  EVALUATION_SETUP_STATUS_LABELS,
  EVALUATION_SETUP_VISIBLE_STATUSES,
  isEvaluationSetupAssignable,
} from "./evaluation-setup-status";

test("MAYBE stays visible in evaluation setup without becoming newly assignable", () => {
  assert.deepEqual(EVALUATION_SETUP_VISIBLE_STATUSES, [
    "SUBMITTED",
    "UNDER_REVIEW",
    "MAYBE",
    "ACCEPTED",
    "REJECTED",
    "WITHDRAWN",
  ]);
  assert.equal(EVALUATION_SETUP_STATUS_LABELS.MAYBE, "Maybe");
  assert.equal(isEvaluationSetupAssignable("MAYBE"), false);
});

test("only submitted and under-review proposals are newly assignable", () => {
  assert.equal(isEvaluationSetupAssignable("SUBMITTED"), true);
  assert.equal(isEvaluationSetupAssignable("UNDER_REVIEW"), true);
  for (const status of ["DRAFT", "MAYBE", "ACCEPTED", "REJECTED", "WITHDRAWN"] as const) {
    assert.equal(isEvaluationSetupAssignable(status), false, status);
  }
});
