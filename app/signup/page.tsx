import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Mic2, UserPlus } from "lucide-react";
import { getPendingIdentity, getResolvedSession, homeForRole } from "@/lib/auth";
import { PASSWORD_MIN_LENGTH, PASSWORD_POLICY_HINT } from "@/lib/services/password-policy";

export const metadata: Metadata = { title: "Create an account" };

/**
 * Public self-service sign-up (D-C5-16 item 2).
 *
 * A plain form post to a route handler, exactly like `/login`: the page works
 * with JavaScript switched off, and an API client drives the same endpoint.
 */

/**
 * Refusal copy. The taken-address case is the one place this surface is
 * deliberately specific rather than generic — see the enumeration tradeoff
 * recorded in `app/api/auth/signup/route.ts` — and even then it only names the
 * two doors that work.
 */
function signUpError(error: string | undefined, retryAfter: string | undefined): string | null {
  if (error === "taken") {
    return "An account already uses that email address. Sign in instead, or reset the password if you have forgotten it.";
  }
  if (error === "invalid") {
    return `Check the form: a valid email address and two matching passwords are required. ${PASSWORD_POLICY_HINT}`;
  }
  if (error === "throttled") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      const minutes = Math.ceil(seconds / 60);
      const wait = seconds < 60 ? "in less than a minute" : `in about ${minutes} minute${minutes === 1 ? "" : "s"}`;
      return `Too many sign-up attempts. Try again ${wait}.`;
    }
    return "Too many sign-up attempts. Try again shortly.";
  }
  if (error === "unavailable") return "Sign-up is temporarily unavailable. Try again shortly.";
  if (error === "blocked") return "That sign-up did not come from this site. Start again from this page.";
  return null;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; retryAfter?: string | string[] }>;
}) {
  // Someone already signed in has no business on this page; a pending identity
  // belongs on the welcome page, not back at the start of the funnel.
  const session = await getResolvedSession();
  if (session) redirect(homeForRole(session.role));
  const pending = await getPendingIdentity();
  if (pending) redirect("/welcome");

  const params = await searchParams;
  const error = signUpError(firstParam(params.error), firstParam(params.retryAfter));

  return (
    <div className="login-screen">
      <main className="login-card">
        <div className="brand login-brand">
          <span className="brand-mark">
            <Mic2 size={18} aria-hidden="true" />
          </span>
          <span>Greenroom</span>
        </div>
        <h1>Create an account</h1>
        <p className="login-hint">
          Set up your own organizer account. You will be able to create an event straight away, or
          wait for an organizer to add you to theirs.
        </p>

        <form className="login-credentials" method="post" action="/api/auth/signup">
          {error ? (
            <p className="login-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="login-field">
            <label htmlFor="signup-email">Email</label>
            <input
              autoComplete="username"
              id="signup-email"
              inputMode="email"
              maxLength={254}
              name="email"
              required
              type="email"
            />
          </div>
          <div className="login-field">
            <label htmlFor="signup-password">Password</label>
            <input
              aria-describedby="signup-password-hint"
              autoComplete="new-password"
              id="signup-password"
              maxLength={512}
              minLength={PASSWORD_MIN_LENGTH}
              name="password"
              required
              type="password"
            />
            <span className="hint" id="signup-password-hint">{PASSWORD_POLICY_HINT}</span>
          </div>
          <div className="login-field">
            <label htmlFor="signup-confirm">Confirm password</label>
            <input
              autoComplete="new-password"
              id="signup-confirm"
              maxLength={512}
              minLength={PASSWORD_MIN_LENGTH}
              name="confirmPassword"
              required
              type="password"
            />
          </div>
          <button className="button primary login-submit" type="submit">
            <UserPlus size={16} aria-hidden="true" />
            Create account
          </button>
          <p className="login-note">
            Already have an account? <Link href="/login">Sign in</Link>. Forgotten your password?{" "}
            <Link href="/forgot">Reset it</Link>.
          </p>
        </form>
      </main>
    </div>
  );
}
