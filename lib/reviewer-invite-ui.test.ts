import assert from "node:assert/strict";
import test from "node:test";
import {
  canResendReviewerInvite,
  describeReviewerInviteResendWait,
  reviewerInviteFailureMessage,
  reviewerInviteLifecycleText,
  reviewerInvitePostNotice,
  reviewerInviteResendHint,
} from "./reviewer-invite-ui";

test("reviewer invite lifecycle copy is explicit about pending delivery and accepted access", () => {
  assert.equal(reviewerInviteLifecycleText(null), null);
  assert.equal(reviewerInviteLifecycleText({
    state: "pending", expiresAt: "2030-01-01T00:00:00.000Z", resendAvailableAt: null, delivery: "mocked",
  }), "Invitation pending acceptance · no email was delivered here, share the invite link");
  assert.match(reviewerInviteLifecycleText({
    state: "pending", expiresAt: "2030-01-01T00:00:00.000Z", resendAvailableAt: null, delivery: "failed",
  }) ?? "", /share the invite link/);
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
  // Nothing sent yet and an unreadable timestamp both mean the client cannot
  // prove a cooldown, so the server decides rather than the button latching off.
  assert.equal(canResendReviewerInvite("not-a-date", now), true);
  assert.equal(canResendReviewerInvite(null, now), true);
});

test("cooldown copy names the real wait instead of a bare permanent refusal", () => {
  const now = Date.parse("2030-01-01T12:00:00.000Z");
  assert.equal(describeReviewerInviteResendWait(0), "in less than a minute");
  assert.equal(describeReviewerInviteResendWait(59_000), "in less than a minute");
  assert.equal(describeReviewerInviteResendWait(60_000), "in about 1 minute");
  assert.equal(describeReviewerInviteResendWait(61_000), "in about 2 minutes");
  assert.equal(describeReviewerInviteResendWait(600_000), "in about 10 minutes");

  assert.equal(
    reviewerInviteResendHint("2030-01-01T12:07:30.000Z", now),
    "Resend available in about 8 minutes.",
  );
  assert.equal(
    reviewerInviteResendHint("2030-01-01T12:00:30.000Z", now),
    "Resend available in less than a minute.",
  );
  // Available, never sent, and pre-hydration each say something honest, and
  // none of them is a bare "not available yet".
  assert.equal(reviewerInviteResendHint("2030-01-01T11:59:00.000Z", now), null);
  assert.equal(reviewerInviteResendHint(null, now), null);
  assert.match(reviewerInviteResendHint("2030-01-01T12:07:30.000Z", null) ?? "", /^Checking when a resend is available/);
  assert.match(reviewerInviteResendHint("not-a-date", now) ?? "", /server will confirm/);
});

test("invite result and error copy preserves the token-free server lifecycle", () => {
  assert.equal(reviewerInvitePostNotice({
    state: "invited", access: "active", expiresAt: "2030-01-01T00:00:00.000Z", resendAvailableAt: null, delivery: "sent",
  }), "Reviewer access is ready and the invitation was sent.");
  assert.equal(reviewerInvitePostNotice({
    state: "active", access: "active", expiresAt: null, resendAvailableAt: null, delivery: "not_sent",
  }), "This reviewer already has active access.");
  // A mocked or failed delivery must send the operator to the link, not to a
  // dead wait for an email nothing will deliver.
  assert.match(reviewerInvitePostNotice({
    state: "invited", access: "active", expiresAt: "2030-01-01T00:00:00.000Z", resendAvailableAt: null, delivery: "mocked",
  }), /Show invite link/);
  assert.match(reviewerInvitePostNotice({
    state: "invited", access: "active", expiresAt: "2030-01-01T00:00:00.000Z", resendAvailableAt: null, delivery: "failed",
  }), /Show invite link/);
  assert.match(reviewerInviteFailureMessage("REVIEWER_ROLE_CONFLICT", "fallback"), /already a speaker/);
  assert.match(reviewerInviteFailureMessage("INVITE_RESEND_COOLDOWN", "fallback"), /wait/);
  assert.match(reviewerInviteFailureMessage("INVITE_NOT_FOUND", "fallback"), /Send a fresh invitation/);
  assert.equal(reviewerInviteFailureMessage("UNKNOWN", "fallback"), "fallback");
});
