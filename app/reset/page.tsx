import type { Metadata } from "next";
import Link from "next/link";
import { KeyRound, Mic2 } from "lucide-react";
import { PASSWORD_MIN_LENGTH, PASSWORD_POLICY_HINT } from "@/lib/services/password-policy";
import { PASSWORD_RESET_INVALID_TOKEN_MESSAGE } from "@/lib/services/self-service-auth-copy";
import { resolvePasswordResetToken } from "@/lib/services/password-reset-redeem";

export const metadata: Metadata = { title: "Choose a new password" };

// The token in the query string must never be resolved from a cached render.
export const dynamic = "force-dynamic";

/**
 * Set a new password from a signed link (D-C5-16 item 2).
 *
 * The page validates the token through the SAME resolver the POST uses, so it
 * never renders a form the route would refuse. Every failure — malformed,
 * expired, unknown user, no credential, already spent — reaches the identical
 * calm message; the page has no branch that could tell them apart.
 *
 * The form carries the token in a hidden field rather than relying on the URL,
 * so the POST is a normal same-origin form submission with no referer
 * dependency.
 */

function resetError(error: string | undefined, retryAfter: string | undefined): string | null {
  if (error === "invalid") {
    return `Check the form: two matching passwords are required. ${PASSWORD_POLICY_HINT}`;
  }
  if (error === "throttled") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      const minutes = Math.ceil(seconds / 60);
      const wait = seconds < 60 ? "in less than a minute" : `in about ${minutes} minute${minutes === 1 ? "" : "s"}`;
      return `Too many attempts. Try again ${wait}.`;
    }
    return "Too many attempts. Try again shortly.";
  }
  if (error === "unavailable") return "Password reset is temporarily unavailable. Try again shortly.";
  if (error === "blocked") return "That request did not come from this site. Open the link from your email again.";
  return null;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="login-screen">
      <main className="login-card">
        <div className="brand login-brand">
          <span className="brand-mark">
            <Mic2 size={18} aria-hidden="true" />
          </span>
          <span>Greenroom</span>
        </div>
        {children}
      </main>
    </div>
  );
}

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{
    token?: string | string[];
    error?: string | string[];
    retryAfter?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const token = firstParam(params.token) ?? "";
  const errorKey = firstParam(params.error);

  // `?error=token` is the route's own refusal coming back through a form post;
  // it renders the same message a bad token in the URL does.
  const resolved = errorKey === "token" ? null : await resolvePasswordResetToken(token);

  if (!resolved) {
    return (
      <Shell>
        <h1>That link has expired</h1>
        <p className="login-error" role="alert">{PASSWORD_RESET_INVALID_TOKEN_MESSAGE}</p>
        <p className="login-note">
          <Link href="/forgot">Request a new reset link</Link>, or{" "}
          <Link href="/login">sign in</Link> if you remembered your password.
        </p>
      </Shell>
    );
  }

  const error = resetError(errorKey, firstParam(params.retryAfter));

  return (
    <Shell>
      <h1>Choose a new password</h1>
      <p className="login-hint">
        Setting a new password for {resolved.user.email}. This link stops working as soon as the
        password changes.
      </p>

      <form className="login-credentials" method="post" action="/api/auth/reset">
        {error ? (
          <p className="login-error" role="alert">
            {error}
          </p>
        ) : null}
        <input name="token" type="hidden" value={token} />
        <div className="login-field">
          <label htmlFor="reset-password">New password</label>
          <input
            aria-describedby="reset-password-hint"
            autoComplete="new-password"
            id="reset-password"
            maxLength={512}
            minLength={PASSWORD_MIN_LENGTH}
            name="password"
            required
            type="password"
          />
          <span className="hint" id="reset-password-hint">{PASSWORD_POLICY_HINT}</span>
        </div>
        <div className="login-field">
          <label htmlFor="reset-confirm">Confirm new password</label>
          <input
            autoComplete="new-password"
            id="reset-confirm"
            maxLength={512}
            minLength={PASSWORD_MIN_LENGTH}
            name="confirmPassword"
            required
            type="password"
          />
        </div>
        <button className="primary-button login-submit" type="submit">
          <KeyRound size={16} aria-hidden="true" />
          Set new password
        </button>
      </form>
    </Shell>
  );
}
