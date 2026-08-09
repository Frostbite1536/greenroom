import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PUBLIC_SUBMISSION_RATE_LIMITS,
  publicClientIp,
  publicSubmissionFingerprint,
  publicSubmissionRateLockKeys,
  publicSubmissionRatePlan,
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
  assert.match(source, /throw new ApiError\(429, "PUBLIC_SUBMISSION_RATE_LIMITED"/);
});

test("413 and 429 preflight precede core public writer calls", () => {
  const route = readFileSync(new URL("../../app/api/cfp/submissions/route.ts", import.meta.url), "utf8");
  assert.ok(route.indexOf("parseBoundedJson(req)") < route.indexOf("prisma.formConfig.findUnique"));
  assert.ok(route.indexOf("enforcePublicSubmissionRateLimit") < route.indexOf("const saved = await prisma.$transaction"));
  const businessWriter = route.slice(route.indexOf("const saved = await prisma.$transaction"));
  assert.match(businessWriter, /tx\.user\.upsert/);
  assert.match(businessWriter, /tx\.abstract\.(?:create|update)/);
});
