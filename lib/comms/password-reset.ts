import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { dispatchEmail, type Fetcher } from "@/lib/comms/send";

/**
 * The password-reset email (D-C5-16 item 2).
 *
 * This goes through the **existing audited dispatch path** — `dispatchEmail` —
 * rather than calling a provider directly, which buys three things the reset
 * flow needs anyway: the `EmailDispatch` row is written *before* the provider
 * call (so a crash leaves evidence rather than silence), the mock branch is the
 * same one every other send uses, and the operator's email history shows reset
 * traffic beside everything else.
 *
 * Two conventions from the existing senders are followed deliberately:
 *
 * 1. **Fixed source, not a stored template (C21 truth rule).** `EmailDispatch`
 *    requires a `templateId`, and `EmailTemplate` is event-scoped — but a
 *    password reset belongs to an identity, not to an event. `notify-service.ts`
 *    already met this exact problem and answered it: an arbitrary template row
 *    is used as the **dispatch-log parent ONLY**, never rendered, because
 *    rendering whatever template an event happens to have could mail an
 *    acceptance notice to someone who asked for a password link. The copy below
 *    is fixed, and the audit row records `source: "fixed"` so the console never
 *    claims a template drove a send it did not.
 * 2. **The bearer link never enters `variables`.** The reviewer-invite sender is
 *    pinned by its contract test to keep `inviteUrl` out of the audit row for
 *    the same reason: `EmailDispatch.variables` is durable, operator-readable
 *    storage, and a reset token in it would be a stored credential.
 *
 * Like `notifyAbstractSubmitted`, this **never throws**. `/forgot` must answer
 * identically whether or not mail went out — an exception that changed the
 * response would reintroduce exactly the enumeration oracle the neutral
 * response exists to prevent.
 */

export type PasswordResetNotificationDb = Pick<PrismaClient, "emailTemplate" | "emailDispatch">;

export type PasswordResetSendResult = { status: "sent" | "mocked" | "failed" | "skipped"; reason?: string };

/**
 * Only a configured deployment URL is trusted for a link someone will click.
 *
 * `Host` is request input; a reset link built from it is a phishing primitive.
 * This mirrors `trustedReviewerInviteAppUrl` in `lib/services/reviewer-invite.ts`
 * exactly. It is a copy rather than a shared helper because that function's
 * body — including its `console.warn` line — is pinned byte-for-byte by
 * `reviewer-invite-route-contract.test.ts`, and refactoring a verified boundary
 * to save twelve lines is the wrong trade this close to a freeze. Extracting one
 * shared `trustedAppUrl()` is a named follow-up.
 */
export function trustedPasswordResetAppUrl(): string | null {
  const configured = process.env.APP_URL?.trim();
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (parsed.protocol === "https:" || (process.env.NODE_ENV !== "production" && parsed.protocol === "http:")) {
        return parsed.origin;
      }
    } catch (error) {
      // The exception name is safe diagnostic context; never log APP_URL itself.
      console.warn("[password-reset] invalid configured APP_URL", error instanceof Error ? error.name : "unknown");
    }
  }
  return process.env.NODE_ENV === "production" ? null : "http://localhost:3000";
}

export const PASSWORD_RESET_SUBJECT = "Reset your Greenroom password";

/**
 * Fixed copy. Says how long the link lasts and what to do if the request was not
 * theirs, and names no event, role, or anything else that would confirm what the
 * recipient's account can see.
 */
export function buildPasswordResetEmail(input: { name: string; resetUrl: string; minutes: number }): {
  subject: string;
  html: string;
} {
  const greeting = input.name.trim() ? `Hello ${escapeHtml(input.name.trim())},` : "Hello,";
  return {
    subject: PASSWORD_RESET_SUBJECT,
    html:
      `<p>${greeting}</p>` +
      `<p>Someone asked to reset the password for this Greenroom account. ` +
      `Choose a new one here:</p>` +
      `<p><a href="${escapeHtml(input.resetUrl)}">Set a new password</a></p>` +
      `<p>The link works for ${input.minutes} minutes, and once for one password change.</p>` +
      `<p>If this was not you, nothing has changed and you can ignore this message.</p>`,
  };
}

/** Minimal, sufficient for an attribute or text node in the fixed markup above. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Send one reset email. Never throws; the outcome is returned, not signalled.
 *
 * The caller has already decided this address deserves a link — this function
 * makes no account decisions and performs no lookups that could differ between a
 * known and an unknown address.
 */
export async function sendPasswordResetEmail(
  input: { to: string; name: string; userId: string; resetUrl: string; minutes: number },
  options: { fetcher?: Fetcher; db?: PasswordResetNotificationDb } = {},
): Promise<PasswordResetSendResult> {
  try {
    const db = options.db ?? prisma;
    // Dispatch-log parent ONLY — never rendered. Ordered so the choice is stable
    // across runs rather than dependent on row order.
    const template = await db.emailTemplate.findFirst({
      select: { id: true },
      orderBy: [{ eventId: "asc" }, { key: "asc" }],
    });
    if (!template) return { status: "skipped", reason: "no_template" };

    const content = buildPasswordResetEmail({ name: input.name, resetUrl: input.resetUrl, minutes: input.minutes });
    const outcome = await dispatchEmail(db, {
      templateId: template.id,
      message: { to: input.to, subject: content.subject, html: content.html },
      // `userId` is an identifier, not a secret. The token and the URL that
      // carries it are deliberately absent: this row is durable storage.
      variables: { kind: "password-reset", source: "fixed", userId: input.userId },
      fetcher: options.fetcher,
    });
    return { status: outcome.status };
  } catch (error) {
    // Swallowed on purpose — see the module header. Class only: the recipient,
    // the token and the URL never reach a log.
    console.error("[password-reset] dispatch failed", error instanceof Error ? error.name : "unknown");
    return { status: "failed", reason: "dispatch_error" };
  }
}
