import { ApiError } from "@/lib/api/http";
import { getServerSigningSecret } from "@/lib/server-signing";
import { loginRateAnchorEventId } from "@/lib/services/login-rate";
import {
  describePublicSubmissionRetryWait,
  enforceRateBucketPlans,
  publicSubmissionRetryAfterSeconds,
  rateBucketPlan,
  type PublicRateBucketPlan,
  type RateRule,
} from "@/lib/services/public-submission-rate";

/**
 * Throttles for the self-service auth surfaces (D-C5-16 item 2).
 *
 * Same durable machinery as S19 and credential login: the shared
 * `PublicSubmissionRateBucket` table, domain-separated HMAC fingerprints (no raw
 * address or IP ever reaches storage), the same expired-row sweep and advisory
 * lock ordering. New throttles are new **scopes**, never a new table — the rule
 * `lib/services/public-submission-rate.ts` states in its own header.
 *
 * The partition anchor is `loginRateAnchorEventId()`, reused rather than forked:
 * none of these endpoints is event-scoped (a person signing up has no event
 * yet), so the anchor is a partition key and never an authorization input.
 *
 * Every bucket is charged **before** any `User` row is read, on every path. That
 * is the property that stops a throttle becoming an account oracle: an address
 * that exists and one that does not consume exactly the same budget.
 */
export const SELF_SERVICE_AUTH_RATE_LIMITS = {
  // Wide enough for a shared NAT — a table of organizers signing up at the same
  // conference wifi is the honest case this must not refuse, the same reasoning
  // `LOGIN_RATE_LIMITS.loginIp` records — and narrow enough that scripted
  // account creation from one address stalls within a minute. Note that an
  // attempt is charged here even when it is refused for a taken address or a
  // weak password, so the real budget for *created* accounts is lower still.
  signupIp: { scope: "signup_ip_1h", limit: 10, windowMs: 60 * 60 * 1_000, order: 10 },
  // The narrow rule: bounds an attacker who rotates addresses while probing one
  // email for the 409. Charged for taken and free addresses alike, so it can
  // never be read as an answer about whether an account exists.
  signupEmail: { scope: "signup_email_1h", limit: 3, windowMs: 60 * 60 * 1_000, order: 20 },
  // Reset requests send mail, so the per-address bucket is the one that matters:
  // it is what stops this endpoint being used to flood one person's inbox. The
  // per-IP ceiling is the wider NAT-tolerant backstop.
  forgotIp: { scope: "forgot_ip_1h", limit: 10, windowMs: 60 * 60 * 1_000, order: 30 },
  forgotEmail: { scope: "forgot_email_1h", limit: 3, windowMs: 60 * 60 * 1_000, order: 40 },
  // Redeeming is cheaper than requesting and a person legitimately retries after
  // a mistyped confirmation, so this one is wider. It exists to bound signature
  // guessing, which the HMAC already makes hopeless.
  resetIp: { scope: "reset_ip_1h", limit: 10, windowMs: 60 * 60 * 1_000, order: 50 },
} as const satisfies Record<string, RateRule>;

export const SELF_SERVICE_AUTH_RATE_NAMESPACE = "self-service-auth-rate";
export const SELF_SERVICE_AUTH_RATE_LIMITED_CODE = "SELF_SERVICE_AUTH_RATE_LIMITED";
export const SELF_SERVICE_AUTH_UNAVAILABLE_CODE = "SELF_SERVICE_AUTH_UNAVAILABLE";

export type SelfServiceAuthIntent = "signup" | "forgot" | "reset";

/**
 * The buckets one attempt is charged against.
 *
 * `/reset` deliberately has no per-email bucket: the redeemer supplies a token,
 * not an address, and deriving a bucket key from the token's user id would make
 * the throttle's own behaviour depend on which account the token names.
 */
export function selfServiceAuthRatePlan(input: {
  intent: SelfServiceAuthIntent;
  email: string;
  clientIp: string;
  secret: string;
  now: Date;
}): PublicRateBucketPlan[] {
  const { secret, clientIp, now } = input;
  const email = input.email.trim().toLowerCase();
  const plans: PublicRateBucketPlan[] = [];
  if (input.intent === "signup") {
    plans.push(rateBucketPlan(secret, SELF_SERVICE_AUTH_RATE_LIMITS.signupIp, "signup-ip", clientIp, now));
    plans.push(rateBucketPlan(secret, SELF_SERVICE_AUTH_RATE_LIMITS.signupEmail, "signup-email", email, now));
  } else if (input.intent === "forgot") {
    plans.push(rateBucketPlan(secret, SELF_SERVICE_AUTH_RATE_LIMITS.forgotIp, "forgot-ip", clientIp, now));
    plans.push(rateBucketPlan(secret, SELF_SERVICE_AUTH_RATE_LIMITS.forgotEmail, "forgot-email", email, now));
  } else {
    plans.push(rateBucketPlan(secret, SELF_SERVICE_AUTH_RATE_LIMITS.resetIp, "reset-ip", clientIp, now));
  }
  return plans.sort((left, right) => left.order - right.order || left.scope.localeCompare(right.scope));
}

/** One refusal shape for all three, with the honest wait the merged contract requires. */
export function selfServiceAuthRateLimitError(plan: PublicRateBucketPlan, now: Date): ApiError {
  const retryAfterSeconds = publicSubmissionRetryAfterSeconds(plan.expiresAt, now);
  const message = `Too many attempts. Try again ${describePublicSubmissionRetryWait(retryAfterSeconds)}.`;
  return new ApiError(429, SELF_SERVICE_AUTH_RATE_LIMITED_CODE, message, undefined, retryAfterSeconds);
}

function selfServiceAuthUnavailable(): ApiError {
  return new ApiError(503, SELF_SERVICE_AUTH_UNAVAILABLE_CODE, "This is temporarily unavailable. Try again shortly.");
}

/**
 * Throttle one self-service auth attempt. Fails **closed**: without a signing
 * secret or any event to partition on, the endpoint refuses rather than running
 * unlimited.
 *
 * Must be awaited before the caller reads any `User` row.
 */
export async function enforceSelfServiceAuthRateLimit(input: {
  intent: SelfServiceAuthIntent;
  email: string;
  clientIp: string;
  now?: Date;
}): Promise<void> {
  const secret = getServerSigningSecret();
  if (!secret) throw selfServiceAuthUnavailable();
  const eventId = await loginRateAnchorEventId();
  if (!eventId) throw selfServiceAuthUnavailable();
  const now = input.now ?? new Date();
  await enforceRateBucketPlans({
    namespace: SELF_SERVICE_AUTH_RATE_NAMESPACE,
    eventId,
    plans: selfServiceAuthRatePlan({
      intent: input.intent,
      email: input.email,
      clientIp: input.clientIp,
      secret,
      now,
    }),
    now,
    refuse: selfServiceAuthRateLimitError,
  });
}
