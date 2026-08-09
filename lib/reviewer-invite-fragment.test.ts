import assert from "node:assert/strict";
import test from "node:test";
import {
  hasReviewerInviteFragment,
  parseReviewerInviteFragment,
  withoutReviewerInviteFragment,
} from "./reviewer-invite-fragment";

test("reviewer invite tokens are fragment-only and strictly parsed", () => {
  assert.equal(hasReviewerInviteFragment("#invite=opaque-token"), true);
  assert.equal(parseReviewerInviteFragment("#invite=opaque-token"), "opaque-token");
  assert.equal(parseReviewerInviteFragment("#invite="), null);
  assert.equal(parseReviewerInviteFragment("#invite=one&invite=two"), null);
  assert.equal(parseReviewerInviteFragment("#invite=opaque-token&next=anything"), null);
  assert.equal(parseReviewerInviteFragment("#section"), null);
  assert.equal(parseReviewerInviteFragment(`#invite=${"a".repeat(1_025)}`), null);
});

test("the replacement target removes the whole invite fragment without growing history", () => {
  assert.equal(withoutReviewerInviteFragment("/reviewer-invite", ""), "/reviewer-invite");
  assert.equal(withoutReviewerInviteFragment("/reviewer-invite", "?from=email"), "/reviewer-invite?from=email");
});
