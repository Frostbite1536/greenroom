import type { Metadata } from "next";
import Link from "next/link";
import { Mic2, Send } from "lucide-react";
import { PASSWORD_RESET_NEUTRAL_MESSAGE } from "@/lib/services/self-service-auth-copy";

export const metadata: Metadata = { title: "Reset your password" };

/**
 * Request a password reset (D-C5-16 item 2).
 *
 * The confirmation copy is imported from the route rather than restated, so the
 * sentence a browser sees after a form post and the sentence an API client gets
 * back are the same sentence. Two copies of a "neutral" message is exactly how a
 * neutral message stops being neutral.
 *
 * Unlike `/signup` and `/login`, this page does NOT redirect a signed-in
 * visitor away: someone who is signed in on one device and locked out on
 * another has a real reason to be here.
 */

function forgotError(error: string | undefined, retryAfter: string | undefined): string | null {
  if (error === "invalid") return "That does not look like an email address. Check it and try again.";
  if (error === "throttled") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      const minutes = Math.ceil(seconds / 60);
      const wait = seconds < 60 ? "in less than a minute" : `in about ${minutes} minute${minutes === 1 ? "" : "s"}`;
      return `Too many reset requests. Try again ${wait}.`;
    }
    return "Too many reset requests. Try again shortly.";
  }
  if (error === "unavailable") return "Password reset is temporarily unavailable. Try again shortly.";
  if (error === "blocked") return "That request did not come from this site. Start again from this page.";
  return null;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; retryAfter?: string | string[]; sent?: string | string[] }>;
}) {
  const params = await searchParams;
  const error = forgotError(firstParam(params.error), firstParam(params.retryAfter));
  const sent = firstParam(params.sent) === "1";

  return (
    <div className="login-screen">
      <main className="login-card">
        <div className="brand login-brand">
          <span className="brand-mark">
            <Mic2 size={18} aria-hidden="true" />
          </span>
          <span>Greenroom</span>
        </div>
        <h1>Reset your password</h1>
        <p className="login-hint">
          Enter the email address on your account and we will send a link to choose a new password.
        </p>

        {sent ? (
          <p className="login-note" role="status" aria-live="polite">
            {PASSWORD_RESET_NEUTRAL_MESSAGE}
          </p>
        ) : null}

        <form className="login-credentials" method="post" action="/api/auth/forgot">
          {error ? (
            <p className="login-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="login-field">
            <label htmlFor="forgot-email">Email</label>
            <input
              autoComplete="username"
              id="forgot-email"
              inputMode="email"
              maxLength={254}
              name="email"
              required
              type="email"
            />
          </div>
          <button className="button primary login-submit" type="submit">
            <Send size={16} aria-hidden="true" />
            Send reset link
          </button>
          <p className="login-note">
            The link works for 30 minutes and for one password change. Remembered it?{" "}
            <Link href="/login">Sign in</Link>.
          </p>
        </form>
      </main>
    </div>
  );
}
