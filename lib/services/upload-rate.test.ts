import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { toResponse } from "@/lib/api/http";
import {
  UPLOAD_RATE_LIMITED_CODE,
  UPLOAD_RATE_LIMITS,
  UPLOAD_RATE_NAMESPACE,
  uploadRateLimitError,
  uploadRatePlan,
} from "./upload-rate";
import {
  PUBLIC_SUBMISSION_RATE_LIMITS,
  publicSubmissionFingerprint,
  rateBucketLockKeys,
} from "./public-submission-rate";

const secret = "scratch-signing-secret-at-least-32-characters";
const now = new Date("2026-08-10T12:34:56.000Z");

test("the upload plan is two per-user buckets: a burst rule and an hour ceiling", () => {
  const plans = uploadRatePlan({ userId: "user-1", secret, now });
  assert.deepEqual(plans.map((plan) => plan.scope), ["upload_user_1m", "upload_user_1h"]);
  assert.deepEqual(plans.map((plan) => plan.limit), [6, 60]);
  assert.equal(UPLOAD_RATE_LIMITS.uploadUserMinute.windowMs, 60 * 1_000);
  assert.equal(UPLOAD_RATE_LIMITS.uploadUserHour.windowMs, 60 * 60 * 1_000);
});

test("the user id is fingerprinted, and its domain is separate from every other throttle's", () => {
  const plans = uploadRatePlan({ userId: "user-1", secret, now });
  for (const plan of plans) {
    assert.match(plan.fingerprint, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(plan.fingerprint, /user-1/);
  }
  for (const domain of ["ip", "event", "primary-email", "login-ip", "login-email"]) {
    assert.notEqual(
      publicSubmissionFingerprint(secret, "upload-user", "user-1"),
      publicSubmissionFingerprint(secret, domain, "user-1"),
      `the upload domain must not collide with ${domain}`,
    );
  }
  // Two users are two budgets.
  assert.notEqual(
    uploadRatePlan({ userId: "user-1", secret, now })[0]!.fingerprint,
    uploadRatePlan({ userId: "user-2", secret, now })[0]!.fingerprint,
  );
});

test("the two rules share a fingerprint but never a bucket, because the scope differs", () => {
  const [minute, hour] = uploadRatePlan({ userId: "user-1", secret, now });
  // `PublicSubmissionRateBucket` is unique on (eventId, scope, fingerprint,
  // windowStart): equal fingerprints with different scopes are distinct rows,
  // so the hour ceiling is never spent by the minute rule.
  assert.equal(minute!.fingerprint, hour!.fingerprint);
  assert.notEqual(minute!.scope, hour!.scope);
});

test("buckets are windowed on a fixed grid, so the advertised wait is real", () => {
  const [minute, hour] = uploadRatePlan({ userId: "user-1", secret, now });
  assert.equal(minute!.expiresAt.getTime() - minute!.windowStart.getTime(), UPLOAD_RATE_LIMITS.uploadUserMinute.windowMs);
  assert.equal(hour!.expiresAt.getTime() - hour!.windowStart.getTime(), UPLOAD_RATE_LIMITS.uploadUserHour.windowMs);
  assert.equal(minute!.windowStart.getTime() % UPLOAD_RATE_LIMITS.uploadUserMinute.windowMs, 0);
  assert.ok(minute!.windowStart <= now && now < minute!.expiresAt);
  assert.ok(hour!.windowStart <= now && now < hour!.expiresAt);
});

test("the refusal is a 429 with an honest, non-zero Retry-After on the header and the body", async () => {
  const [minute] = uploadRatePlan({ userId: "user-1", secret, now });
  const error = uploadRateLimitError(minute!, now);
  assert.equal(error.status, 429);
  assert.equal(error.code, UPLOAD_RATE_LIMITED_CODE);
  assert.match(error.message, /Try again in (about \d+ (minutes?|hours?)|less than a minute)\./);
  // It names uploads, not sign-in or CFP writes: shared machinery, not copy.
  assert.doesNotMatch(error.message, /sign-in|CFP|submission/i);

  const response = toResponse(error);
  assert.equal(response.status, 429);
  const retryAfter = Number(response.headers.get("Retry-After"));
  assert.ok(Number.isInteger(retryAfter) && retryAfter > 0);
  const body = await response.json();
  assert.equal(body.error.code, UPLOAD_RATE_LIMITED_CODE);
  assert.equal(body.error.retryAfterSeconds, retryAfter);

  assert.ok((uploadRateLimitError(minute!, minute!.expiresAt).retryAfterSeconds ?? 0) >= 1);
});

test("uploads take their own advisory namespace, so they queue behind neither login nor CFP", () => {
  const plans = uploadRatePlan({ userId: "user-1", secret, now });
  const keys = rateBucketLockKeys(UPLOAD_RATE_NAMESPACE, "event-1", [...plans].reverse());
  assert.deepEqual(keys, [
    "file-upload-rate:event-1:010:upload_user_1m",
    "file-upload-rate:event-1:020:upload_user_1h",
  ]);
  for (const key of keys) assert.doesNotMatch(key, /^(public-submission-rate|credential-login-rate):/);
  // The throttles already on this table are untouched.
  assert.equal(PUBLIC_SUBMISSION_RATE_LIMITS.writeIp.limit, 20);
  assert.equal(PUBLIC_SUBMISSION_RATE_LIMITS.submitPrimaryEmail.limit, 10);
});

test("upload throttling fails closed, reuses the shared table, and never counts StoredFile", () => {
  const source = readFileSync(new URL("./upload-rate.ts", import.meta.url), "utf8");
  assert.match(source, /if \(!secret\) throw new ApiError\(503, UPLOAD_RATE_UNAVAILABLE_CODE/);
  assert.match(source, /enforceRateBucketPlans/);
  // No forked table and no hand-rolled SQL: the machinery is the shared module's.
  assert.doesNotMatch(source, /CREATE TABLE|INSERT INTO|\$queryRaw|\$executeRaw/);
  // Dedupe means a repeated upload inserts nothing, so a count over the product
  // table would undercount exactly the attempts a throttle exists to bound.
  assert.doesNotMatch(source, /storedFile\.|prisma\./);
  assert.doesNotMatch(source, /console\./);
});
