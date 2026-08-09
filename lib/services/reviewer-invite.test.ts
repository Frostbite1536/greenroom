import assert from "node:assert/strict";
import test from "node:test";
import {
  REVIEWER_INVITE_RESEND_COOLDOWN_MS,
  canReserveReviewerInviteSend,
  createReviewerInviteToken,
  isReviewerInvitePending,
  planReviewerInviteSend,
  reviewerInviteEventHourLockKey,
  reviewerInviteResendAvailableAt,
  trustedReviewerInviteAppUrl,
  reviewerInviteWindowStart,
  verifyReviewerInviteToken,
} from "./reviewer-invite";

const secret = "a reviewer invite test secret that is safely longer than thirty two characters";
const now = new Date("2026-08-10T12:34:56.000Z");
const expiresAt = new Date("2026-08-17T12:34:56.000Z");

test("reviewer invite tokens are signed, bounded, expiring, and carry no persisted nonce requirement", () => {
  const token = createReviewerInviteToken({ inviteId: "invite-a", version: 3, expiresAt, nonce: "a".repeat(43) }, secret);
  assert.match(token, /^v1\.invite-a\.3\.\d+\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(verifyReviewerInviteToken(token, secret, now), {
    inviteId: "invite-a", version: 3, expiresAt, nonce: "a".repeat(43),
  });
  assert.equal(verifyReviewerInviteToken(`${token}x`, secret, now), null);
  assert.equal(verifyReviewerInviteToken(token, secret, expiresAt), null);
  assert.equal(verifyReviewerInviteToken("x".repeat(513), secret, now), null);
});

test("invite delivery state distinguishes a pending token from consumed or expired versions", () => {
  assert.equal(isReviewerInvitePending({ expiresAt, acceptedVersion: null, tokenVersion: 1 }, now), true);
  assert.equal(isReviewerInvitePending({ expiresAt, acceptedVersion: 1, tokenVersion: 1 }, now), false);
  assert.equal(isReviewerInvitePending({ expiresAt: now, acceptedVersion: null, tokenVersion: 1 }, now), false);
  assert.equal(REVIEWER_INVITE_RESEND_COOLDOWN_MS, 600_000);
});

test("resend availability is an absolute timestamp while the server remains authoritative", () => {
  assert.equal(reviewerInviteResendAvailableAt(null), null);
  assert.deepEqual(
    reviewerInviteResendAvailableAt(now),
    new Date(now.getTime() + REVIEWER_INVITE_RESEND_COOLDOWN_MS),
  );
});

test("invite sends are idempotent until explicit renewal, then cooldown and hour counters apply", () => {
  const active = {
    tokenVersion: 4,
    expiresAt,
    acceptedVersion: null,
    lastSentAt: new Date(now),
    sendWindowStart: reviewerInviteWindowStart(now),
    sendWindowCount: 7,
  };
  assert.deepEqual(planReviewerInviteSend(active, { resend: false, now, windowStart: reviewerInviteWindowStart(now) }), { kind: "pending" });
  assert.deepEqual(planReviewerInviteSend(active, { resend: true, now, windowStart: reviewerInviteWindowStart(now) }), { kind: "cooldown" });
  assert.deepEqual(
    planReviewerInviteSend(active, {
      resend: true,
      now: new Date(now.getTime() + REVIEWER_INVITE_RESEND_COOLDOWN_MS),
      windowStart: reviewerInviteWindowStart(now),
    }),
    { kind: "send", tokenVersion: 5, sendWindowCount: 8 },
  );
  assert.deepEqual(
    planReviewerInviteSend({ ...active, expiresAt: now }, { resend: false, now, windowStart: reviewerInviteWindowStart(now) }),
    { kind: "send", tokenVersion: 5, sendWindowCount: 8 },
  );
  assert.equal(canReserveReviewerInviteSend(19), true);
  assert.equal(canReserveReviewerInviteSend(20), false);
});

test("an accepted evaluator is already active unless an explicit resend renews access", () => {
  const accepted = {
    tokenVersion: 4,
    expiresAt,
    acceptedVersion: 4,
    lastSentAt: new Date(now.getTime() - REVIEWER_INVITE_RESEND_COOLDOWN_MS),
    sendWindowStart: reviewerInviteWindowStart(now),
    sendWindowCount: 2,
  };
  assert.deepEqual(planReviewerInviteSend(accepted, { resend: false, now, windowStart: reviewerInviteWindowStart(now) }), { kind: "active" });
  assert.deepEqual(planReviewerInviteSend(accepted, { resend: true, now, windowStart: reviewerInviteWindowStart(now) }), { kind: "send", tokenVersion: 5, sendWindowCount: 3 });
});

test("invite cap lock key is event-hour scoped and UTC-normalized", () => {
  const window = reviewerInviteWindowStart(now);
  assert.equal(window.toISOString(), "2026-08-10T12:00:00.000Z");
  assert.equal(reviewerInviteEventHourLockKey("event-a", window), "reviewer-invite-event-hour:event-a:2026-08-10T12:00:00.000Z");
});

test("trusted reviewer invite origins never derive from request data and production fails closed", () => {
  const env = process.env as Record<string, string | undefined>;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAppUrl = process.env.APP_URL;
  try {
    env.NODE_ENV = "production";
    delete env.APP_URL;
    assert.equal(trustedReviewerInviteAppUrl(), null);
    env.APP_URL = "https://greenroom-hq.com/ignored-path";
    assert.equal(trustedReviewerInviteAppUrl(), "https://greenroom-hq.com");
    env.APP_URL = "http://unsafe.example";
    assert.equal(trustedReviewerInviteAppUrl(), null);
  } finally {
    if (originalNodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = originalNodeEnv;
    if (originalAppUrl === undefined) delete env.APP_URL;
    else env.APP_URL = originalAppUrl;
  }
});
