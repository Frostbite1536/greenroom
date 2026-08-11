import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { toResponse } from "@/lib/api/http";
import {
  ASSISTANT_RATE_LIMITED_CODE,
  ASSISTANT_RATE_LIMITS,
  ASSISTANT_RATE_NAMESPACE,
  assistantRateLimitError,
  assistantRatePlan,
} from "./assistant-rate";
import { UPLOAD_RATE_LIMITS, UPLOAD_RATE_NAMESPACE } from "./upload-rate";
import {
  PUBLIC_SUBMISSION_RATE_LIMITS,
  publicSubmissionFingerprint,
  rateBucketLockKeys,
} from "./public-submission-rate";

const secret = "scratch-signing-secret-at-least-32-characters";
const now = new Date("2026-08-11T12:34:56.000Z");
const plan = (userId = "admin-1", eventId = "event-1") => assistantRatePlan({ userId, eventId, secret, now });

test("the assistant plan is a per-admin burst, a per-admin hour, and an event-wide day", () => {
  const plans = plan();
  assert.deepEqual(plans.map((entry) => entry.scope), [
    "assistant_admin_1m",
    "assistant_admin_1h",
    "assistant_event_1d",
  ]);
  assert.deepEqual(plans.map((entry) => entry.limit), [5, 30, 200]);
  assert.equal(ASSISTANT_RATE_LIMITS.assistantAdminMinute.windowMs, 60 * 1_000);
  assert.equal(ASSISTANT_RATE_LIMITS.assistantAdminHour.windowMs, 60 * 60 * 1_000);
  assert.equal(ASSISTANT_RATE_LIMITS.assistantEventDay.windowMs, 24 * 60 * 60 * 1_000);
});

test("the daily ceiling is the event's, so extra admin identities cannot dilute it", () => {
  // The demo's persona logins mean a public judge can hold an ADMIN session.
  // The two per-admin buckets differ per caller; the daily one must not.
  const [, , dayOne] = plan("admin-1");
  const [, , dayTwo] = plan("admin-2");
  assert.equal(dayOne!.fingerprint, dayTwo!.fingerprint, "the day ceiling is keyed on the event, not the caller");

  const [minuteOne] = plan("admin-1");
  const [minuteTwo] = plan("admin-2");
  assert.notEqual(minuteOne!.fingerprint, minuteTwo!.fingerprint, "two admins are two burst budgets");

  // A second event gets its own daily budget.
  const [, , otherEvent] = plan("admin-1", "event-2");
  assert.notEqual(dayOne!.fingerprint, otherEvent!.fingerprint);
});

test("ids are fingerprinted, and the assistant domains collide with no other throttle's", () => {
  for (const entry of plan()) {
    assert.match(entry.fingerprint, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(entry.fingerprint, /admin-1|event-1/);
  }
  for (const domain of ["ip", "event", "primary-email", "login-ip", "login-email", "upload-user", "signup-ip"]) {
    assert.notEqual(
      publicSubmissionFingerprint(secret, "assistant-admin", "admin-1"),
      publicSubmissionFingerprint(secret, domain, "admin-1"),
      `the assistant-admin domain must not collide with ${domain}`,
    );
    assert.notEqual(
      publicSubmissionFingerprint(secret, "assistant-event", "event-1"),
      publicSubmissionFingerprint(secret, domain, "event-1"),
      `the assistant-event domain must not collide with ${domain}`,
    );
  }
});

test("the two per-admin rules share a fingerprint but never a bucket, because the scope differs", () => {
  const [minute, hour] = plan();
  // `PublicSubmissionRateBucket` is unique on (eventId, scope, fingerprint,
  // windowStart): equal fingerprints under different scopes are distinct rows,
  // so the hour ceiling is never spent by the burst rule.
  assert.equal(minute!.fingerprint, hour!.fingerprint);
  assert.notEqual(minute!.scope, hour!.scope);
});

test("buckets are windowed on a fixed grid, so the advertised wait is real", () => {
  for (const [entry, rule] of [
    [plan()[0]!, ASSISTANT_RATE_LIMITS.assistantAdminMinute],
    [plan()[1]!, ASSISTANT_RATE_LIMITS.assistantAdminHour],
    [plan()[2]!, ASSISTANT_RATE_LIMITS.assistantEventDay],
  ] as const) {
    assert.equal(entry.expiresAt.getTime() - entry.windowStart.getTime(), rule.windowMs);
    assert.equal(entry.windowStart.getTime() % rule.windowMs, 0);
    assert.ok(entry.windowStart <= now && now < entry.expiresAt);
  }
});

test("the refusal is a 429 with an honest, non-zero Retry-After on the header and the body", async () => {
  const [minute] = plan();
  const error = assistantRateLimitError(minute!, now);
  assert.equal(error.status, 429);
  assert.equal(error.code, ASSISTANT_RATE_LIMITED_CODE);
  assert.match(error.message, /Try again in (about \d+ (minutes?|hours?)|less than a minute)\./);
  // It names drafting, not uploads, sign-in, or CFP writes: shared machinery,
  // not shared copy.
  assert.doesNotMatch(error.message, /upload|sign-in|CFP|submission/i);

  const response = toResponse(error);
  assert.equal(response.status, 429);
  const retryAfter = Number(response.headers.get("Retry-After"));
  assert.ok(Number.isInteger(retryAfter) && retryAfter > 0);
  const body = await response.json();
  assert.equal(body.error.code, ASSISTANT_RATE_LIMITED_CODE);
  assert.equal(body.error.retryAfterSeconds, retryAfter);

  // The day bucket's wait is capped by its own window, not left unbounded.
  const [, , day] = plan();
  assert.ok((assistantRateLimitError(day!, day!.expiresAt).retryAfterSeconds ?? 0) >= 1);
});

test("the assistant takes its own advisory namespace, so it queues behind no other throttle", () => {
  const keys = rateBucketLockKeys(ASSISTANT_RATE_NAMESPACE, "event-1", [...plan()].reverse());
  assert.deepEqual(keys, [
    "assistant-rate:event-1:010:assistant_admin_1m",
    "assistant-rate:event-1:020:assistant_admin_1h",
    "assistant-rate:event-1:030:assistant_event_1d",
  ]);
  for (const key of keys) {
    assert.doesNotMatch(
      key,
      /^(public-submission-rate|credential-login-rate|self-service-auth-rate|file-upload-rate):/,
    );
  }
  assert.notEqual(ASSISTANT_RATE_NAMESPACE, UPLOAD_RATE_NAMESPACE);
  // The throttles already on this table are untouched.
  assert.equal(PUBLIC_SUBMISSION_RATE_LIMITS.writeIp.limit, 20);
  assert.equal(UPLOAD_RATE_LIMITS.uploadUserMinute.limit, 6);
});

test("assistant throttling fails closed and reuses the shared table rather than a new one", () => {
  // CRLF-safe: no pattern below crosses a line break.
  const source = readFileSync(new URL("./assistant-rate.ts", import.meta.url), "utf8");
  assert.match(source, /if \(!secret\) \{/);
  assert.match(source, /throw new ApiError\(503, ASSISTANT_RATE_UNAVAILABLE_CODE/);
  assert.match(source, /enforceRateBucketPlans/);
  // No forked table and no hand-rolled SQL: the machinery is the shared
  // module's, which is what keeps this a zero-schema-change addition.
  assert.doesNotMatch(source, /CREATE TABLE|INSERT INTO|\$queryRaw|\$executeRaw/);
  assert.doesNotMatch(source, /prisma\./);
  assert.doesNotMatch(source, /console\./);
  // The throttle is charged before the provider is reached, so it must not
  // import the client and become ordering-sensitive.
  assert.doesNotMatch(source, /@\/lib\/assistant/);
});
