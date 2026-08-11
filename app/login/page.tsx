import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ClipboardCheck, LogIn, Mic2, ShieldCheck, Users } from "lucide-react";
import { DEMO_PERSONAS, getResolvedSession, homeForRole } from "@/lib/auth";
import { arePersonaLoginsEnabled } from "@/lib/env";
import { loginAsPersona } from "./actions";

export const metadata: Metadata = { title: "Sign in" };

const personas = [
  {
    key: "admin",
    icon: ShieldCheck,
    label: "Event admin",
    detail: "Forms, evaluations, agenda, speaker status",
  },
  {
    key: "evaluator",
    icon: ClipboardCheck,
    label: "Evaluator",
    detail: "Score assigned abstracts by rubric",
  },
  {
    key: "speaker",
    icon: Users,
    label: "Speaker",
    detail: "Portal, onboarding tasks, profile",
  },
] as const;

/**
 * Refusals are deliberately one message. Unknown address, wrong password, and
 * an account without a password all arrive here as `?error=invalid`, matching
 * the route's single 401.
 */
function signInError(error: string | undefined, retryAfter: string | undefined): string | null {
  if (error === "invalid") return "Email or password is incorrect.";
  if (error === "throttled") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      const minutes = Math.ceil(seconds / 60);
      const wait = seconds < 60 ? "in less than a minute" : `in about ${minutes} minute${minutes === 1 ? "" : "s"}`;
      return `Too many sign-in attempts. Try again ${wait}.`;
    }
    return "Too many sign-in attempts. Try again shortly.";
  }
  if (error === "unavailable") return "Sign-in is temporarily unavailable. Try again shortly.";
  // GRA2-01. Not a credential failure and not the visitor's mistake: the demo
  // personas are switched off on this deployment, so the page says so plainly
  // and points at the way in that does work.
  if (error === "personas-disabled") {
    return "One-click demo accounts are turned off on this deployment. Sign in with your email and password.";
  }
  // The post did not come from this site. A real sign-in never lands here, so
  // the copy points at the cause rather than blaming the credentials.
  if (error === "blocked") return "That sign-in did not come from this site. Start again from this page.";
  return null;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; retryAfter?: string | string[] }>;
}) {
  const session = await getResolvedSession();
  if (session) {
    redirect(homeForRole(session.role));
  }
  const params = await searchParams;
  const error = signInError(firstParam(params.error), firstParam(params.retryAfter));
  // GRA2-01: one source of truth with the server action that actually refuses.
  // Hiding the buttons is courtesy — `loginAsPersona` is the boundary.
  const personasEnabled = arePersonaLoginsEnabled();

  return (
    <div className="login-screen">
      <main className="login-card">
        <div className="brand login-brand">
          <span className="brand-mark">
            <Mic2 size={18} aria-hidden="true" />
          </span>
          <span>Greenroom</span>
        </div>
        <h1>Sign in</h1>
        <p className="login-hint">
          {DEMO_PERSONAS.admin.event.name}. Sign in with the email and password your organizer gave
          you, or open a demo account with one click.
        </p>

        {/* Plain form post: the credential path is a route handler, so this page
            works without JavaScript and an API client uses the same endpoint. */}
        <form className="login-credentials" method="post" action="/api/auth/login">
          {error ? (
            <p className="login-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="login-field">
            <label htmlFor="login-email">Email</label>
            <input
              autoComplete="username"
              id="login-email"
              inputMode="email"
              maxLength={254}
              name="email"
              required
              type="email"
            />
          </div>
          <div className="login-field">
            <label htmlFor="login-password">Password</label>
            <input
              autoComplete="current-password"
              id="login-password"
              maxLength={512}
              name="password"
              required
              type="password"
            />
          </div>
          <button className="button primary login-submit" type="submit">
            <LogIn size={16} aria-hidden="true" />
            Sign in
          </button>
          <p className="login-note">
            Self-service sign-up is on the roadmap — for now organizers provision accounts. Password
            reset is not available yet — ask your event organizer if you need access.
          </p>
        </form>

        {personasEnabled ? (
          <>
            <div className="login-divider" role="separator">
              <span>or explore the demo</span>
            </div>

            <p className="login-hint">These demo accounts stay one-click. No password required.</p>
            <div className="login-personas">
              {personas.map(({ key, icon: Icon, label, detail }) => (
                <form action={loginAsPersona} key={key}>
                  <input name="persona" type="hidden" value={key} />
                  <button className="persona-button" type="submit">
                    <Icon size={18} aria-hidden="true" />
                    <span className="persona-copy">
                      <strong>{label}</strong>
                      <span>{detail}</span>
                    </span>
                  </button>
                </form>
              ))}
            </div>
          </>
        ) : null}
      </main>
    </div>
  );
}
