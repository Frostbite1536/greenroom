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
 * File-upload throttling.
 *
 * Reuses the S19 durable bucket machinery rather than counting rows in
 * `StoredFile`: the table is the *product* of an upload, so a count over it
 * would be defeated by dedupe (a repeated upload returns the existing id
 * without inserting) while still charging honest first-time uploads. The
 * bucket rows are charged per attempt, before any bytes are stored, which is
 * the only place a cap on *work* can be enforced.
 *
 * Two rules, both per user. The minute rule is what an accidental double-click
 * or a retry loop hits; the hour rule is what a deliberate one does. Neither is
 * keyed on the client address: an upload is authenticated, so the account is
 * the honest subject and an address key would only punish shared NAT.
 */
export const UPLOAD_RATE_LIMITS = {
  uploadUserMinute: { scope: "upload_user_1m", limit: 6, windowMs: 60 * 1_000, order: 10 },
  uploadUserHour: { scope: "upload_user_1h", limit: 60, windowMs: 60 * 60 * 1_000, order: 20 },
} as const satisfies Record<string, RateRule>;

export const UPLOAD_RATE_NAMESPACE = "file-upload-rate";
export const UPLOAD_RATE_LIMITED_CODE = "UPLOAD_RATE_LIMITED";
export const UPLOAD_RATE_UNAVAILABLE_CODE = "UPLOAD_RATE_UNAVAILABLE";

export function uploadRatePlan(input: {
  userId: string;
  secret: string;
  now: Date;
}): PublicRateBucketPlan[] {
  return [
    rateBucketPlan(input.secret, UPLOAD_RATE_LIMITS.uploadUserMinute, "upload-user", input.userId, input.now),
    rateBucketPlan(input.secret, UPLOAD_RATE_LIMITS.uploadUserHour, "upload-user", input.userId, input.now),
  ].sort((left, right) => left.order - right.order || left.scope.localeCompare(right.scope));
}

/** The one upload refusal, with the wait derived from the refusing window. */
export function uploadRateLimitError(plan: PublicRateBucketPlan, now: Date): ApiError {
  const retryAfterSeconds = publicSubmissionRetryAfterSeconds(plan.expiresAt, now);
  const message = `Too many uploads. Try again ${describePublicSubmissionRetryWait(retryAfterSeconds)}.`;
  return new ApiError(429, UPLOAD_RATE_LIMITED_CODE, message, undefined, retryAfterSeconds);
}

/**
 * Charge one upload attempt. Fails **closed**: with no signing secret the
 * fingerprints cannot be derived, and an unlimited upload endpoint is a worse
 * outcome than a refused one.
 *
 * `eventId` is the caller's own active event, used only as the bucket table's
 * partition key — it is never an authorization input here.
 */
export async function enforceUploadRateLimit(input: {
  userId: string;
  eventId: string;
  now?: Date;
}): Promise<void> {
  const secret = getServerSigningSecret();
  if (!secret) throw new ApiError(503, UPLOAD_RATE_UNAVAILABLE_CODE, "Uploads are temporarily unavailable.");
  const now = input.now ?? new Date();
  await enforceRateBucketPlans({
    namespace: UPLOAD_RATE_NAMESPACE,
    eventId: input.eventId,
    plans: uploadRatePlan({ userId: input.userId, secret, now }),
    now,
    refuse: uploadRateLimitError,
  });
}
