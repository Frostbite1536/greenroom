import assert from "node:assert/strict";
import test from "node:test";
import {
  canResendReviewerInvite,
  reviewerInviteFailureMessage,
  reviewerInviteLifecycleText,
  reviewerInvitePostNotice,
} from "./reviewer-invite-ui";

test("reviewer invite lifecycle copy is explicit about pending delivery and accepted access", () => {
  assert.equal(reviewerInviteLifecycleText(null), null);
  assert.equal(reviewerInviteLifecycleText({
    state: "pending", expiresAt: "2030-01-01T00:00:00.000Z", resendAvailableAt: null, delivery: "mocked",
  }), "Invitation pending acceptance · delivery is mocked here");
  assert.equal(reviewerInviteLifecycleText({
    state: "accepted", expiresAt: "2030-01-01T00:00:00.000Z", resendAvailableAt: null, delivery: "sent",
  }), "Invitation accepted");
  assert.equal(reviewerInviteLifecycleText({
    state: "expired", expiresAt: "2020-01-01T00:00:00.000Z", resendAvailableAt: null, delivery: "failed",
  }), "Invitation expired");
});

test("resend enablement consumes an absolute server timestamp but never replaces server authority", () => {
  const now = Date.parse("2030-01-01T12:00:00.000Z");
  assert.equal(canResendReviewerInvite("2030-01-01T11:59:59.000Z", now), true);
  assert.equal(canResendReviewerInvite("2030-01-01T12:00:01.000Z", now), false);
  assert.equal(canResendReviewerInvite("not-a-date", now), false);
  assert.equal(canResendReviewerInvite(null, now), false);
});

test("invite result and error copy preserves the token-free server lifecycle", () => {
  assert.equal(reviewerInvitePostNotice({
    state: "invited", access: "active", expiresAt: "2030-01-01T00:00:00.000Z", resendAvailableAt: null, delivery: "sent",
  }), "Reviewer access is ready and the invitation was sent.");
  assert.equal(reviewerInvitePostNotice({
    state: "active", access: "active", expiresAt: null, resendAvailableAt: null, delivery: "not_sent",
  }), "This reviewer already has active access.");
  assert.match(reviewerInviteFailureMessage("REVIEWER_ROLE_CONFLICT", "fallback"), /already a speaker/);
  assert.match(reviewerInviteFailureMessage("INVITE_RESEND_COOLDOWN", "fallback"), /wait/);
  assert.equal(reviewerInviteFailureMessage("UNKNOWN", "fallback"), "fallback");
});
