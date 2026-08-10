import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ApiError, toResponse } from "@/lib/api/http";
import {
  PUBLIC_SUBMISSION_RATE_LIMITS,
  describePublicSubmissionRetryWait,
  publicClientIp,
  publicSubmissionFingerprint,
  publicSubmissionRateLimitError,
  publicSubmissionRateLockKeys,
  publicSubmissionRatePlan,
  publicSubmissionRetryAfterSeconds,
} from "./public-submission-rate";

const secret = "scratch-signing-secret-at-least-32-characters";
const now = new Date("2026-08-09T12:34:56.000Z");

test("public rate plans use the named limits and HMAC-only fingerprints", () => {
  const draft = publicSubmissionRatePlan({
    eventId: "event-1", intent: "saveDraft", primaryEmail: "primary@example.test", clientIp: "203.0.113.10", secret, now,
  });
  const submit = publicSubmissionRatePlan({
    eventId: "event-1", intent: "submit", primaryEmail: "primary@example.test", clientIp: "203.0.113.10", secret, now,
  });
  assert.deepEqual(draft.map((plan) => plan.scope), [
    PUBLIC_SUBMISSION_RATE_LIMITS.writeIp.scope,
    PUBLIC_SUBMISSION_RATE_LIMITS.writeEvent.scope,
  ]);
  assert.deepEqual(submit.map((plan) => plan.scope), [
    PUBLIC_SUBMISSION_RATE_LIMITS.writeIp.scope,
    PUBLIC_SUBMISSION_RATE_LIMITS.writeEvent.scope,
    PUBLIC_SUBMISSION_RATE_LIMITS.submitPrimaryEmail.scope,
    PUBLIC_SUBMISSION_RATE_LIMITS.submitEvent.scope,
  ]);
  assert.deepEqual(submit.map((plan) => plan.limit), [
    PUBLIC_SUBMISSION_RATE_LIMITS.writeIp.limit,
    PUBLIC_SUBMISSION_RATE_LIMITS.writeEvent.limit,
    PUBLIC_SUBMISSION_RATE_LIMITS.submitPrimaryEmail.limit,
    PUBLIC_SUBMISSION_RATE_LIMITS.submitEvent.limit,
  ]);
  for (const plan of submit) {
    assert.match(plan.fingerprint, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(plan.fingerprint, /203\.0\.113\.10|primary@example/);
  }
  assert.notEqual(
    publicSubmissionFingerprint(secret, "ip", "203.0.113.10"),
    publicSubmissionFingerprint(secret, "primary-email", "203.0.113.10"),
  );
});

test("public client IP accepts only one validated Vercel address and never parses a list", () => {
  assert.equal(publicClientIp(new Headers({ "x-vercel-forwarded-for": "203.0.113.10", "x-forwarded-for": "198.51.100.2" })), "203.0.113.10");
  assert.equal(publicClientIp(new Headers({ "x-forwarded-for": "2001:db8::1" })), "2001:db8::1");
  assert.equal(publicClientIp(new Headers({ "x-vercel-forwarded-for": "203.0.113.10, 198.51.100.2" })), "unknown");
});

test("rate locks have exact IP, event, primary-email, then submit-event order and the bucket mutation is atomic", () => {
  const plans = publicSubmissionRatePlan({
    eventId: "event-1", intent: "submit", primaryEmail: "primary@example.test", clientIp: "unknown", secret, now,
  });
  const keys = publicSubmissionRateLockKeys("event-1", [...plans].reverse());
  assert.deepEqual(keys, [
    "public-submission-rate:event-1:010:public_write_ip_10m",
    "public-submission-rate:event-1:020:public_write_event_1h",
    "public-submission-rate:event-1:030:submit_primary_email_24h",
    "public-submission-rate:event-1:040:submit_event_1h",
  ]);
  const source = readFileSync(new URL("./public-submission-rate.ts", import.meta.url), "utf8");
  assert.match(source, /INSERT INTO "PublicSubmissionRateBucket"[\s\S]*ON CONFLICT[\s\S]*"count" = "PublicSubmissionRateBucket"\."count" \+ 1[\s\S]*RETURNING "count"/);
  assert.match(source, /new ApiError\(429, "PUBLIC_SUBMISSION_RATE_LIMITED"/);
  assert.match(source, /if \(count > plan\.limit\) throw publicSubmissionRateLimitError\(plan, now\)/);
});

test("the named public rate ceilings are the ratified values", () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(PUBLIC_SUBMISSION_RATE_LIMITS).map(([name, rule]) => [name, [rule.limit, rule.windowMs]]),
    ),
    {
      writeIp: [20, 10 * 60 * 1_000],
      writeEvent: [120, 60 * 60 * 1_000],
      // Relaxed from 3: one speaker's fixture proposals plus edits must not
      // exhaust a day's budget mid-session.
      submitPrimaryEmail: [10, 24 * 60 * 60 * 1_000],
      submitEvent: [60, 60 * 60 * 1_000],
    },
  );
});

test("a refusal reports the refusing bucket's real window rollover, never a guess", () => {
  const plans = publicSubmissionRatePlan({
    eventId: "event-1", intent: "submit", primaryEmail: "primary@example.test", clientIp: "203.0.113.10", secret, now,
  });
  const ruleByScope = new Map<string, number>(
    Object.values(PUBLIC_SUBMISSION_RATE_LIMITS).map((rule) => [rule.scope, rule.windowMs]),
  );
  for (const plan of plans) {
    // The advertised moment is windowStart + windowMs, not a fixed constant.
    assert.equal(plan.expiresAt.getTime(), plan.windowStart.getTime() + ruleByScope.get(plan.scope)!);
    const error = publicSubmissionRateLimitError(plan, now);
    assert.equal(error.status, 429);
    assert.equal(error.code, "PUBLIC_SUBMISSION_RATE_LIMITED");
    assert.equal(error.retryAfterSeconds, Math.ceil((plan.expiresAt.getTime() - now.getTime()) / 1_000));
    assert.ok(error.retryAfterSeconds! >= 1);
    // Honest: the promised wait never lands before the bucket actually rolls.
    assert.ok(now.getTime() + error.retryAfterSeconds! * 1_000 >= plan.expiresAt.getTime());
    assert.match(error.message, /Try again in (about \d+ (minutes?|hours?)|less than a minute)\./);
    assert.doesNotMatch(error.message, /Please wait before sending another public CFP write/);
  }
});

test("retry-after is a whole, never-zero second count and the wait phrase rounds up", () => {
  const at = (ms: number) => publicSubmissionRetryAfterSeconds(new Date(now.getTime() + ms), now);
  assert.equal(at(10 * 60 * 1_000), 600);
  assert.equal(at(1_500), 2);
  assert.equal(at(0), 1);
  assert.equal(at(-60_000), 1);
  assert.equal(describePublicSubmissionRetryWait(30), "in less than a minute");
  assert.equal(describePublicSubmissionRetryWait(60), "in about 1 minute");
  assert.equal(describePublicSubmissionRetryWait(600), "in about 10 minutes");
  assert.equal(describePublicSubmissionRetryWait(24 * 60 * 60), "in about 24 hours");
});

test("the 429 response carries Retry-After and retryAfterSeconds beside the stable code", async () => {
  const plan = publicSubmissionRatePlan({
    eventId: "event-1", intent: "submit", primaryEmail: "primary@example.test", clientIp: "203.0.113.10", secret, now,
  }).find((candidate) => candidate.scope === PUBLIC_SUBMISSION_RATE_LIMITS.submitPrimaryEmail.scope)!;
  const error = publicSubmissionRateLimitError(plan, now);
  const response = toResponse(error);
  const body = await response.json() as { ok: false; error: { code: string; message: string; retryAfterSeconds?: number } };
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), String(error.retryAfterSeconds));
  assert.match(response.headers.get("Retry-After")!, /^\d+$/);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "PUBLIC_SUBMISSION_RATE_LIMITED");
  assert.equal(body.error.retryAfterSeconds, error.retryAfterSeconds);
  assert.equal(body.error.message, error.message);
});

test("refusals that do not know when they clear stay header-free", async () => {
  const response = toResponse(new ApiError(404, "FORM_NOT_FOUND", "This form is not available."));
  const body = await response.json() as { error: { retryAfterSeconds?: number } };
  assert.equal(response.headers.get("Retry-After"), null);
  assert.equal(body.error.retryAfterSeconds, undefined);
});

test("413 and 429 preflight precede core public writer calls", () => {
  const route = readFileSync(new URL("../../app/api/cfp/submissions/route.ts", import.meta.url), "utf8");
  assert.ok(route.indexOf("parseBoundedJson(req)") < route.indexOf("prisma.formConfig.findUnique"));
  assert.ok(route.indexOf("enforcePublicSubmissionRateLimit") < route.indexOf("const saved = await prisma.$transaction"));
  const businessWriter = route.slice(route.indexOf("const saved = await prisma.$transaction"));
  assert.match(businessWriter, /tx\.user\.upsert/);
  assert.match(businessWriter, /tx\.abstract\.(?:create|update)/);
});
