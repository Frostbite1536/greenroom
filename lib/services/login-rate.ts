import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api/http";
import { getServerSigningSecret } from "@/lib/server-signing";
import {
  describePublicSubmissionRetryWait,
  enforceRateBucketPlans,
  publicSubmissionRetryAfterSeconds,
  rateBucketPlan,
  type PublicRateBucketPlan,
  type RateRule,
} from "@/lib/services/public-submission-rate";

/**
 * Credential-login throttling (D-C5-6 ruling 2).
 *
 * This reuses the S19 durable HMAC bucket machinery rather than forking it: the
 * same `PublicSubmissionRateBucket` table, the same domain-separated HMAC
 * fingerprints (no raw address or email ever reaches storage), the same
 * expired-row sweep and advisory-lock ordering. Login adds **scopes**, plus its
 * own advisory namespace so a login burst never queues behind a public CFP
 * burst.
 *
 * Both buckets are incremented for **every** attempt, before any identity
 * lookup happens. That is what keeps the throttle from becoming an account
 * oracle: an unknown address consumes exactly the same budget as a real one.
 */
export const LOGIN_RATE_LIMITS = {
  // Wide enough for a shared office NAT and a few fat-fingered attempts, narrow
  // enough that credential stuffing from one address stalls immediately.
  loginIp: { scope: "login_ip_10m", limit: 10, windowMs: 10 * 60 * 1_000, order: 10 },
  // Per-identity ceiling: bounds an attack that rotates addresses against one
  // known account.
  loginEmail: { scope: "login_email_15m", limit: 5, windowMs: 15 * 60 * 1_000, order: 20 },
} as const satisfies Record<string, RateRule>;

export const LOGIN_RATE_NAMESPACE = "credential-login-rate";
export const LOGIN_RATE_LIMITED_CODE = "LOGIN_RATE_LIMITED";
export const LOGIN_RATE_UNAVAILABLE_CODE = "LOGIN_RATE_UNAVAILABLE";

/**
 * Optional partition anchor for login throttle rows.
 *
 * `PublicSubmissionRateBucket` is partitioned by event, but a sign-in is not
 * event-scoped — the throttle is deliberately global. The anchor is therefore
 * only a partition key, never an authorization input. It defaults to the
 * lexicographically-first event so a single-event deployment needs no
 * configuration; the smoke harness sets it to its own scratch event so its
 * throttle rows never land on the judged demo event.
 */
export const LOGIN_RATE_ANCHOR_ENV = "LOGIN_RATE_ANCHOR_EVENT_ID";

export function loginRatePlan(input: {
  email: string;
  clientIp: string;
  secret: string;
  now: Date;
}): PublicRateBucketPlan[] {
  return [
    rateBucketPlan(input.secret, LOGIN_RATE_LIMITS.loginIp, "login-ip", input.clientIp, input.now),
    rateBucketPlan(input.secret, LOGIN_RATE_LIMITS.loginEmail, "login-email", input.email.trim().toLowerCase(), input.now),
  ].sort((left, right) => left.order - right.order || left.scope.localeCompare(right.scope));
}

/**
 * The one login rate refusal. Honest wait, derived from the refusing bucket's
 * real window end, emitted as both `Retry-After` and `error.retryAfterSeconds`
 * per the merged rate-relax contract.
 */
export function loginRateLimitError(plan: PublicRateBucketPlan, now: Date): ApiError {
  const retryAfterSeconds = publicSubmissionRetryAfterSeconds(plan.expiresAt, now);
  const message = `Too many sign-in attempts. Try again ${describePublicSubmissionRetryWait(retryAfterSeconds)}.`;
  return new ApiError(429, LOGIN_RATE_LIMITED_CODE, message, undefined, retryAfterSeconds);
}

function loginRateUnavailable(): ApiError {
  return new ApiError(503, LOGIN_RATE_UNAVAILABLE_CODE, "Sign-in is temporarily unavailable.");
}

/** Resolve the throttle's partition key. Null means the throttle cannot run. */
export async function loginRateAnchorEventId(): Promise<string | null> {
  const configured = process.env[LOGIN_RATE_ANCHOR_ENV]?.trim();
  if (configured) {
    const named = await prisma.event.findUnique({ where: { id: configured }, select: { id: true } });
    if (named) return named.id;
  }
  const first = await prisma.event.findFirst({ orderBy: { id: "asc" }, select: { id: true } });
  return first?.id ?? null;
}

/**
 * Throttle one credential-login attempt. Fails **closed**: without a signing
 * secret or any event to partition on, sign-in is refused rather than left
 * unlimited.
 *
 * Must be awaited before the caller reads any `User` row.
 */
export async function enforceLoginRateLimit(input: {
  email: string;
  clientIp: string;
  now?: Date;
}): Promise<void> {
  const secret = getServerSigningSecret();
  if (!secret) throw loginRateUnavailable();
  const eventId = await loginRateAnchorEventId();
  if (!eventId) throw loginRateUnavailable();
  const now = input.now ?? new Date();
  await enforceRateBucketPlans({
    namespace: LOGIN_RATE_NAMESPACE,
    eventId,
    plans: loginRatePlan({ email: input.email, clientIp: input.clientIp, secret, now }),
    now,
    refuse: loginRateLimitError,
  });
}
