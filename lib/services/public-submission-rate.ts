import { createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api/http";
import { getServerSigningSecret } from "@/lib/server-signing";

export const PUBLIC_RATE_EXPIRED_BUCKET_CLEANUP_LIMIT = 100;

export const PUBLIC_SUBMISSION_RATE_LIMITS = {
  writeIp: { scope: "public_write_ip_10m", limit: 20, windowMs: 10 * 60 * 1_000, order: 10 },
  writeEvent: { scope: "public_write_event_1h", limit: 120, windowMs: 60 * 60 * 1_000, order: 20 },
  // 10, not 3: a real speaker legitimately submits several proposals plus
  // edits from one primary email in a sitting, and the lower cap refused
  // honest traffic mid-session. Abuse is still bounded by the IP and
  // event-wide ceilings above, which are unchanged.
  submitPrimaryEmail: { scope: "submit_primary_email_24h", limit: 10, windowMs: 24 * 60 * 60 * 1_000, order: 30 },
  submitEvent: { scope: "submit_event_1h", limit: 60, windowMs: 60 * 60 * 1_000, order: 40 },
} as const;

type RateRule = (typeof PUBLIC_SUBMISSION_RATE_LIMITS)[keyof typeof PUBLIC_SUBMISSION_RATE_LIMITS];

export type PublicRateBucketPlan = {
  scope: string;
  fingerprint: string;
  windowStart: Date;
  expiresAt: Date;
  limit: number;
  order: number;
};

function validSingleIp(value: string | null): string | null {
  const candidate = value?.trim() ?? "";
  // Do not select a member from a forwarded list: request headers are input,
  // and only Vercel's single-address forms are trusted as an address signal.
  return candidate && !candidate.includes(",") && isIP(candidate) !== 0 ? candidate : null;
}

/** Prefer Vercel's explicit client address, then its single XFF fallback. */
export function publicClientIp(headers: Headers): string {
  return validSingleIp(headers.get("x-vercel-forwarded-for"))
    ?? validSingleIp(headers.get("x-forwarded-for"))
    ?? "unknown";
}

/** Domain-separated HMAC; raw address and email values never reach storage. */
export function publicSubmissionFingerprint(secret: string, domain: string, value: string): string {
  return createHmac("sha256", secret)
    .update(`greenroom:public-submission-rate:v1:${domain}\u0000${value}`)
    .digest("hex");
}

function bucketWindow(now: Date, rule: RateRule): Pick<PublicRateBucketPlan, "windowStart" | "expiresAt"> {
  const windowStart = new Date(Math.floor(now.getTime() / rule.windowMs) * rule.windowMs);
  return { windowStart, expiresAt: new Date(windowStart.getTime() + rule.windowMs) };
}

function planFor(
  secret: string,
  rule: RateRule,
  domain: string,
  value: string,
  now: Date,
): PublicRateBucketPlan {
  return {
    scope: rule.scope,
    fingerprint: publicSubmissionFingerprint(secret, domain, value),
    ...bucketWindow(now, rule),
    limit: rule.limit,
    order: rule.order,
  };
}

/** Pure policy plan used by both the transaction and regression tests. */
export function publicSubmissionRatePlan(input: {
  eventId: string;
  intent: "saveDraft" | "submit";
  primaryEmail: string;
  clientIp: string;
  secret: string;
  now?: Date;
}): PublicRateBucketPlan[] {
  const now = input.now ?? new Date();
  const plans = [
    planFor(input.secret, PUBLIC_SUBMISSION_RATE_LIMITS.writeIp, "ip", input.clientIp, now),
    // This event-wide bucket applies to drafts as well as submits, so a client
    // cannot bypass the public intake ceiling simply by rotating IP addresses.
    planFor(input.secret, PUBLIC_SUBMISSION_RATE_LIMITS.writeEvent, "event", input.eventId, now),
  ];
  if (input.intent === "submit") {
    plans.push(
      planFor(input.secret, PUBLIC_SUBMISSION_RATE_LIMITS.submitPrimaryEmail, "primary-email", input.primaryEmail.trim().toLowerCase(), now),
      planFor(input.secret, PUBLIC_SUBMISSION_RATE_LIMITS.submitEvent, "event", input.eventId, now),
    );
  }
  return plans.sort((left, right) => left.order - right.order || left.scope.localeCompare(right.scope));
}

/** The rate transaction takes these broad scope keys in this exact order. */
export function publicSubmissionRateLockKeys(eventId: string, plans: readonly PublicRateBucketPlan[]): string[] {
  return [...plans]
    .sort((left, right) => left.order - right.order || left.scope.localeCompare(right.scope))
    .map((plan) => `public-submission-rate:${eventId}:${String(plan.order).padStart(3, "0")}:${plan.scope}`);
}

/**
 * Whole seconds until the refusing bucket's window rolls over — the earliest
 * moment the same request could pass. Never below 1 so `Retry-After` is always
 * an actionable, non-zero delay.
 */
export function publicSubmissionRetryAfterSeconds(expiresAt: Date, now: Date): number {
  return Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1_000));
}

/** Approximate, human-facing wait phrase. Rounds up so it never promises early. */
export function describePublicSubmissionRetryWait(seconds: number): string {
  if (seconds < 60) return "in less than a minute";
  if (seconds < 90 * 60) {
    const minutes = Math.ceil(seconds / 60);
    return `in about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = Math.ceil(seconds / (60 * 60));
  return `in about ${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * The one public rate refusal. The stable `PUBLIC_SUBMISSION_RATE_LIMITED`
 * code is unchanged; the wait is derived from the refusing bucket's real
 * `windowStart + windowMs` rather than left for the caller to guess.
 */
export function publicSubmissionRateLimitError(plan: PublicRateBucketPlan, now: Date): ApiError {
  const retryAfterSeconds = publicSubmissionRetryAfterSeconds(plan.expiresAt, now);
  const message = `Too many public CFP writes right now. Try again ${describePublicSubmissionRetryWait(retryAfterSeconds)}.`;
  return new ApiError(429, "PUBLIC_SUBMISSION_RATE_LIMITED", message, undefined, retryAfterSeconds);
}

async function incrementRateBucket(
  tx: Prisma.TransactionClient,
  eventId: string,
  plan: PublicRateBucketPlan,
  now: Date,
): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "PublicSubmissionRateBucket" (
      "id", "eventId", "scope", "fingerprint", "windowStart", "count", "expiresAt", "createdAt", "updatedAt"
    ) VALUES (
      ${randomUUID()}, ${eventId}, ${plan.scope}, ${plan.fingerprint}, ${plan.windowStart}, 1, ${plan.expiresAt}, ${now}, ${now}
    )
    ON CONFLICT ("eventId", "scope", "fingerprint", "windowStart")
    DO UPDATE SET "count" = "PublicSubmissionRateBucket"."count" + 1,
                  "expiresAt" = EXCLUDED."expiresAt",
                  "updatedAt" = EXCLUDED."updatedAt"
    RETURNING "count"
  `;
  return rows[0]?.count ?? 0;
}

/**
 * Rate limits intentionally use their own short transaction. It commits before
 * the business writer starts, so advisory locks never compose with FormConfig,
 * FormField, identity, or Abstract locks.
 */
export async function enforcePublicSubmissionRateLimit(input: {
  eventId: string;
  intent: "saveDraft" | "submit";
  primaryEmail: string;
  clientIp: string;
  now?: Date;
}): Promise<void> {
  const secret = getServerSigningSecret();
  if (!secret) {
    throw new ApiError(503, "RATE_LIMIT_UNAVAILABLE", "Public submissions are temporarily unavailable.");
  }
  const now = input.now ?? new Date();
  const plans = publicSubmissionRatePlan({ ...input, secret, now });
  await prisma.$transaction(async (tx) => {
    for (const key of publicSubmissionRateLockKeys(input.eventId, plans)) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    }
    await tx.$executeRaw`
      DELETE FROM "PublicSubmissionRateBucket"
      WHERE "id" IN (
        SELECT "id"
        FROM "PublicSubmissionRateBucket"
        WHERE "eventId" = ${input.eventId} AND "expiresAt" <= ${now}
        ORDER BY "expiresAt" ASC, "id" ASC
        LIMIT ${PUBLIC_RATE_EXPIRED_BUCKET_CLEANUP_LIMIT}
      )
    `;
    for (const plan of plans) {
      const count = await incrementRateBucket(tx, input.eventId, plan, now);
      // Measure the advertised wait from the refusal moment, not the request's
      // pre-transaction timestamp: a lock-delayed request would otherwise tell
      // a compliant client to wait longer than the bucket's real remainder.
      if (count > plan.limit) throw publicSubmissionRateLimitError(plan, new Date());
    }
  });
}
