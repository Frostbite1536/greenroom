import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getServerSigningSecret } from "@/lib/server-signing";

export const REVIEWER_INVITE_TEMPLATE_KEY = "reviewer-invite";
export const REVIEWER_INVITE_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7;
export const REVIEWER_INVITE_RESEND_COOLDOWN_MS = 1000 * 60 * 10;
export const REVIEWER_INVITE_EVENT_SEND_CAP = 20;
export const REVIEWER_INVITE_JSON_MAX_BYTES = 8 * 1024;

const TOKEN_VERSION = "v1";
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{43}$/;
const INTEGER_RE = /^[1-9]\d{0,9}$/;

export type ReviewerInviteTokenPayload = {
  inviteId: string;
  version: number;
  expiresAt: Date;
  nonce: string;
};

export type ReviewerInviteDelivery = "sent" | "mocked" | "failed";

export const REVIEWER_INVITE_DEFAULT_TEMPLATE = {
  subject: "You are invited to evaluate proposals for {{eventName}}",
  htmlBody:
    "<p>Hello {{reviewerName}},</p><p>You have been invited to evaluate proposals for {{eventName}}.</p><p><a href=\"{{inviteUrl}}\">Open your reviewer workspace</a></p>",
  trigger: "reviewer.invite",
} as const;

function tokenMessage(payload: Omit<ReviewerInviteTokenPayload, "expiresAt"> & { exp: number }): string {
  return `greenroom:reviewer-invite:v1:${payload.inviteId}:${payload.version}:${payload.exp}:${payload.nonce}`;
}

function tokenSignature(message: string, secret: string): string {
  return createHmac("sha256", secret).update(message).digest("base64url");
}

function alignedExpiry(now: Date, ttlMs = REVIEWER_INVITE_TOKEN_TTL_MS): Date {
  return new Date((Math.floor(now.getTime() / 1000) + Math.floor(ttlMs / 1000)) * 1000);
}

export function createReviewerInviteToken(
  input: { inviteId: string; version: number; expiresAt: Date; nonce?: string },
  secret: string,
): string {
  const exp = Math.floor(input.expiresAt.getTime() / 1000);
  const nonce = input.nonce ?? randomBytes(32).toString("base64url");
  if (!NONCE_RE.test(nonce) || !Number.isSafeInteger(input.version) || input.version < 1 || exp < 1) {
    throw new Error("Reviewer invite token input is invalid.");
  }
  const message = tokenMessage({ inviteId: input.inviteId, version: input.version, exp, nonce });
  return `${TOKEN_VERSION}.${input.inviteId}.${input.version}.${exp}.${nonce}.${tokenSignature(message, secret)}`;
}

/** Structural + signed verification runs before any invite lookup. */
export function verifyReviewerInviteToken(
  raw: unknown,
  secret: string,
  now = new Date(),
): ReviewerInviteTokenPayload | null {
  if (typeof raw !== "string" || raw.length > 512) return null;
  const [prefix, inviteId, versionRaw, expRaw, nonce, supplied, ...extra] = raw.split(".");
  if (
    prefix !== TOKEN_VERSION ||
    !inviteId || inviteId.length > 191 ||
    !INTEGER_RE.test(versionRaw ?? "") ||
    !INTEGER_RE.test(expRaw ?? "") ||
    !nonce || !NONCE_RE.test(nonce) ||
    !supplied || !SIGNATURE_RE.test(supplied) ||
    extra.length > 0
  ) return null;
  const version = Number(versionRaw);
  const exp = Number(expRaw);
  if (!Number.isSafeInteger(version) || !Number.isSafeInteger(exp) || exp * 1000 <= now.getTime()) return null;
  const expected = tokenSignature(tokenMessage({ inviteId, version, exp, nonce }), secret);
  const actualBytes = Buffer.from(supplied, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null;
  return { inviteId, version, expiresAt: new Date(exp * 1000), nonce };
}

/** Event-hour starts are stable UTC boundaries, not local-time calculations. */
export function reviewerInviteWindowStart(now = new Date()): Date {
  const date = new Date(now);
  date.setUTCMinutes(0, 0, 0);
  return date;
}

export function reviewerInviteEventHourLockKey(eventId: string, windowStart: Date): string {
  return `reviewer-invite-event-hour:${eventId}:${windowStart.toISOString()}`;
}

export async function lockReviewerInviteEventHour(
  tx: Prisma.TransactionClient,
  eventId: string,
  windowStart: Date,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${reviewerInviteEventHourLockKey(eventId, windowStart)}, 0))`;
}

/** Only a configured deployment URL is trusted for bearer links; never Host. */
export function trustedReviewerInviteAppUrl(): string | null {
  const configured = process.env.APP_URL?.trim();
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (parsed.protocol === "https:" || (process.env.NODE_ENV !== "production" && parsed.protocol === "http:")) {
        return parsed.origin;
      }
    } catch {
      // A malformed setting is not a request-time authority fallback.
    }
  }
  return process.env.NODE_ENV === "production" ? null : "http://localhost:3000";
}

export function reviewerInviteUrl(appUrl: string, token: string): string {
  return `${appUrl}/reviewer-invite#invite=${encodeURIComponent(token)}`;
}

export function reviewerInviteSigningSecret(): string | null {
  return getServerSigningSecret();
}

export function reviewerInviteExpiry(now = new Date()): Date {
  return alignedExpiry(now);
}

export function isReviewerInvitePending(input: {
  expiresAt: Date;
  acceptedVersion: number | null;
  tokenVersion: number;
}, now = new Date()): boolean {
  return input.expiresAt.getTime() > now.getTime() && input.acceptedVersion !== input.tokenVersion;
}

export type ExistingReviewerInviteForSend = {
  tokenVersion: number;
  expiresAt: Date;
  acceptedVersion: number | null;
  lastSentAt: Date | null;
  sendWindowStart: Date | null;
  sendWindowCount: number;
};

export type ReviewerInviteSendPlan =
  | { kind: "active" }
  | { kind: "pending" }
  | { kind: "cooldown" }
  | { kind: "send"; tokenVersion: number; sendWindowCount: number };

/** Pure lifecycle choice shared by the route and idempotency/cooldown tests. */
export function planReviewerInviteSend(
  existing: ExistingReviewerInviteForSend | null,
  input: { resend: boolean; now: Date; windowStart: Date },
): ReviewerInviteSendPlan {
  if (existing && existing.acceptedVersion === existing.tokenVersion && !input.resend) return { kind: "active" };
  if (existing && isReviewerInvitePending(existing, input.now) && !input.resend) return { kind: "pending" };
  if (
    existing &&
    input.resend &&
    existing.lastSentAt &&
    input.now.getTime() - existing.lastSentAt.getTime() < REVIEWER_INVITE_RESEND_COOLDOWN_MS
  ) return { kind: "cooldown" };
  return {
    kind: "send",
    tokenVersion: (existing?.tokenVersion ?? 0) + 1,
    sendWindowCount: existing?.sendWindowStart?.getTime() === input.windowStart.getTime()
      ? existing.sendWindowCount + 1
      : 1,
  };
}

export function canReserveReviewerInviteSend(currentWindowCount: number): boolean {
  return Number.isSafeInteger(currentWindowCount) && currentWindowCount >= 0 && currentWindowCount < REVIEWER_INVITE_EVENT_SEND_CAP;
}
