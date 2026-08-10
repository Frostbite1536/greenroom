import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { toResponse } from "@/lib/api/http";
import {
  LOGIN_RATE_LIMITED_CODE,
  LOGIN_RATE_LIMITS,
  LOGIN_RATE_NAMESPACE,
  loginRateLimitError,
  loginRatePlan,
} from "./login-rate";
import {
  PUBLIC_SUBMISSION_RATE_LIMITS,
  publicSubmissionFingerprint,
  rateBucketLockKeys,
} from "./public-submission-rate";

const secret = "scratch-signing-secret-at-least-32-characters";
const now = new Date("2026-08-10T12:34:56.000Z");

test("the login plan is exactly the per-IP and per-email buckets D-C5-6 specifies", () => {
  const plans = loginRatePlan({ email: "Speaker@Example.TEST", clientIp: "203.0.113.10", secret, now });
  assert.deepEqual(plans.map((plan) => plan.scope), ["login_ip_10m", "login_email_15m"]);
  assert.deepEqual(plans.map((plan) => plan.limit), [10, 5]);
  assert.equal(LOGIN_RATE_LIMITS.loginIp.windowMs, 10 * 60 * 1_000);
  assert.equal(LOGIN_RATE_LIMITS.loginEmail.windowMs, 15 * 60 * 1_000);
});

test("raw addresses and emails never reach storage, and the domains are separated", () => {
  const plans = loginRatePlan({ email: "speaker@example.test", clientIp: "203.0.113.10", secret, now });
  for (const plan of plans) {
    assert.match(plan.fingerprint, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(plan.fingerprint, /203\.0\.113\.10|speaker@example/);
  }
  // Same value, different domain => different bucket. And the login domains are
  // distinct from the public-submission ones sharing the table.
  assert.notEqual(
    publicSubmissionFingerprint(secret, "login-ip", "203.0.113.10"),
    publicSubmissionFingerprint(secret, "login-email", "203.0.113.10"),
  );
  assert.notEqual(
    publicSubmissionFingerprint(secret, "login-ip", "203.0.113.10"),
    publicSubmissionFingerprint(secret, "ip", "203.0.113.10"),
  );
  assert.notEqual(
    publicSubmissionFingerprint(secret, "login-email", "speaker@example.test"),
    publicSubmissionFingerprint(secret, "primary-email", "speaker@example.test"),
  );
});

test("the email bucket is case- and whitespace-insensitive so casing cannot reset the cap", () => {
  const plain = loginRatePlan({ email: "speaker@example.test", clientIp: "203.0.113.10", secret, now });
  const shouted = loginRatePlan({ email: "  SPEAKER@Example.Test  ", clientIp: "203.0.113.10", secret, now });
  assert.deepEqual(plain.map((plan) => plan.fingerprint), shouted.map((plan) => plan.fingerprint));
});

test("buckets are windowed on a fixed grid, so the advertised wait is real", () => {
  const [ip, email] = loginRatePlan({ email: "speaker@example.test", clientIp: "203.0.113.10", secret, now });
  assert.equal(ip.expiresAt.getTime() - ip.windowStart.getTime(), LOGIN_RATE_LIMITS.loginIp.windowMs);
  assert.equal(email.expiresAt.getTime() - email.windowStart.getTime(), LOGIN_RATE_LIMITS.loginEmail.windowMs);
  assert.equal(ip.windowStart.getTime() % LOGIN_RATE_LIMITS.loginIp.windowMs, 0);
  assert.ok(ip.windowStart <= now && now < ip.expiresAt);
  assert.ok(email.windowStart <= now && now < email.expiresAt);
});

test("the refusal is a 429 with an honest, non-zero Retry-After on the header and the body", async () => {
  const [, email] = loginRatePlan({ email: "speaker@example.test", clientIp: "203.0.113.10", secret, now });
  const error = loginRateLimitError(email, now);
  assert.equal(error.status, 429);
  assert.equal(error.code, LOGIN_RATE_LIMITED_CODE);
  assert.match(error.message, /Try again in (about \d+ (minutes?|hours?)|less than a minute)\./);
  // It names sign-in, not public CFP writes: the two throttles share machinery,
  // not copy.
  assert.doesNotMatch(error.message, /CFP|submission/i);

  const response = toResponse(error);
  assert.equal(response.status, 429);
  const retryAfter = Number(response.headers.get("Retry-After"));
  assert.ok(Number.isInteger(retryAfter) && retryAfter > 0);
  const body = await response.json();
  assert.equal(body.error.code, LOGIN_RATE_LIMITED_CODE);
  assert.equal(body.error.retryAfterSeconds, retryAfter);

  // At the very end of a window the wait rounds up to a usable second.
  const atExpiry = loginRateLimitError(email, email.expiresAt);
  assert.ok((atExpiry.retryAfterSeconds ?? 0) >= 1);
});

test("login takes its own advisory namespace, so it never queues behind a public CFP burst", () => {
  const plans = loginRatePlan({ email: "speaker@example.test", clientIp: "203.0.113.10", secret, now });
  const keys = rateBucketLockKeys(LOGIN_RATE_NAMESPACE, "event-1", [...plans].reverse());
  assert.deepEqual(keys, [
    "credential-login-rate:event-1:010:login_ip_10m",
    "credential-login-rate:event-1:020:login_email_15m",
  ]);
  for (const key of keys) assert.doesNotMatch(key, /^public-submission-rate:/);
  // The public throttle's own keys and limits are untouched by the extraction.
  assert.deepEqual(
    rateBucketLockKeys("public-submission-rate", "event-1", plans),
    ["public-submission-rate:event-1:010:login_ip_10m", "public-submission-rate:event-1:020:login_email_15m"],
  );
  assert.equal(PUBLIC_SUBMISSION_RATE_LIMITS.writeIp.limit, 20);
  assert.equal(PUBLIC_SUBMISSION_RATE_LIMITS.submitPrimaryEmail.limit, 10);
});

test("login throttling fails closed and reuses the shared bucket table", () => {
  const source = readFileSync(new URL("./login-rate.ts", import.meta.url), "utf8");
  // No secret, or no event to partition on => refuse, never "allow unlimited".
  assert.match(source, /if \(!secret\) throw loginRateUnavailable\(\);/);
  assert.match(source, /if \(!eventId\) throw loginRateUnavailable\(\);/);
  assert.match(source, /enforceRateBucketPlans/);
  // No forked table: the SQL lives in the shared module.
  assert.doesNotMatch(source, /CREATE TABLE|INSERT INTO|\$queryRaw|\$executeRaw/);
  assert.doesNotMatch(source, /console\./);
});
