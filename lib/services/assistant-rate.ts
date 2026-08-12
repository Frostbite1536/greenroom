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
 * AI-assistant throttling.
 *
 * Same durable S19 machinery as public submissions, credential login, and file
 * uploads: the shared `PublicSubmissionRateBucket` table, domain-separated HMAC
 * fingerprints so no raw id reaches storage, the same expired-row sweep and
 * advisory-lock ordering. A new throttle is a new **scope**, never a new table,
 * so this adds no schema change.
 *
 * What is different here is the third rule. Uploads and logins bound one
 * subject; a provider call also costs money, and the demo's persona logins mean
 * a public judge can hold an ADMIN session. So the per-admin rules bound one
 * organizer's clicking, and the event-wide daily ceiling bounds the bill no
 * matter how many admin identities are pointed at the button.
 *
 * All three are charged per *attempt*, before the provider is called — a
 * refused or malformed generation still consumed the budget it was going to
 * consume, and a throttle that only counted successes would be trivially
 * defeated by a request shaped to fail.
 */
export const ASSISTANT_RATE_LIMITS = {
  // The double-click and the impatient re-generate. Drafting is an interactive
  // action, so this is what an honest organizer touches first, if ever.
  assistantAdminMinute: { scope: "assistant_admin_1m", limit: 5, windowMs: 60 * 1_000, order: 10 },
  // A working session of decision emails: enough to draft a note for every
  // proposal in a sitting, narrow enough that a loop stalls within the hour.
  assistantAdminHour: { scope: "assistant_admin_1h", limit: 30, windowMs: 60 * 60 * 1_000, order: 20 },
  // The budget ceiling, and the only rule an attacker cannot dilute by using
  // more than one admin identity. Keyed on the event, not the caller.
  assistantEventDay: { scope: "assistant_event_1d", limit: 200, windowMs: 24 * 60 * 60 * 1_000, order: 30 },
} as const satisfies Record<string, RateRule>;

export const ASSISTANT_RATE_NAMESPACE = "assistant-rate";
export const ASSISTANT_RATE_LIMITED_CODE = "ASSISTANT_RATE_LIMITED";
export const ASSISTANT_RATE_UNAVAILABLE_CODE = "ASSISTANT_RATE_UNAVAILABLE";

/**
 * The buckets one drafting attempt is charged against.
 *
 * The two per-admin rules share a fingerprint and differ only in scope, which
 * is what keeps them distinct rows: the table is unique on
 * `(eventId, scope, fingerprint, windowStart)`.
 */
export function assistantRatePlan(input: {
  userId: string;
  eventId: string;
  secret: string;
  now: Date;
}): PublicRateBucketPlan[] {
  return [
    rateBucketPlan(input.secret, ASSISTANT_RATE_LIMITS.assistantAdminMinute, "assistant-admin", input.userId, input.now),
    rateBucketPlan(input.secret, ASSISTANT_RATE_LIMITS.assistantAdminHour, "assistant-admin", input.userId, input.now),
    rateBucketPlan(input.secret, ASSISTANT_RATE_LIMITS.assistantEventDay, "assistant-event", input.eventId, input.now),
  ].sort((left, right) => left.order - right.order || left.scope.localeCompare(right.scope));
}

/** The one assistant refusal, with the wait derived from the refusing window. */
export function assistantRateLimitError(plan: PublicRateBucketPlan, now: Date): ApiError {
  const retryAfterSeconds = publicSubmissionRetryAfterSeconds(plan.expiresAt, now);
  const message = `Too many draft requests. Try again ${describePublicSubmissionRetryWait(retryAfterSeconds)}.`;
  return new ApiError(429, ASSISTANT_RATE_LIMITED_CODE, message, undefined, retryAfterSeconds);
}

/**
 * Charge one assistant attempt. Fails **closed**: with no signing secret the
 * fingerprints cannot be derived, and an unmetered call to a paid provider is a
 * worse outcome than a refused one. The caller's deterministic path is still
 * there either way, which is what makes refusing cheap.
 *
 * `eventId` is the caller's own resolved event. It is the bucket table's
 * partition key and the daily ceiling's subject — never an authorization input.
 */
export async function enforceAssistantRateLimit(input: {
  userId: string;
  eventId: string;
  now?: Date;
}): Promise<void> {
  const secret = getServerSigningSecret();
  if (!secret) {
    throw new ApiError(503, ASSISTANT_RATE_UNAVAILABLE_CODE, "Drafting is temporarily unavailable.");
  }
  const now = input.now ?? new Date();
  await enforceRateBucketPlans({
    namespace: ASSISTANT_RATE_NAMESPACE,
    eventId: input.eventId,
    plans: assistantRatePlan({ userId: input.userId, eventId: input.eventId, secret, now }),
    now,
    refuse: assistantRateLimitError,
  });
}
