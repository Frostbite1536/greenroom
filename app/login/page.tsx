import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ClipboardCheck, Mic2, ShieldCheck, Users } from "lucide-react";
import { DEMO_PERSONAS, getResolvedSession, homeForRole } from "@/lib/auth";
import { loginAsPersona, loginWithEmail } from "./actions";

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

export default async function LoginPage() {
  const session = await getResolvedSession();
  if (session) {
    redirect(homeForRole(session.role));
  }

  return (
    <div className="login-screen">
      <main className="login-card">
        <div className="brand login-brand">
          <span className="brand-mark">
            <Mic2 size={18} aria-hidden="true" />
          </span>
          <span>Greenroom</span>
        </div>
        <h1>Sign in to the demo</h1>
        <p className="login-hint">
          One-click demo accounts for {DEMO_PERSONAS.admin.event.name}. No password required.
        </p>
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
        <div className="login-divider" role="separator">
          or continue as a specific speaker
        </div>
        <form action={loginWithEmail} className="login-email-form">
          <label className="sr-only" htmlFor="login-email">
            Speaker email
          </label>
          <input
            autoComplete="email"
            id="login-email"
            name="email"
            placeholder="you@example.com"
            required
            type="email"
          />
          <button className="primary-button" type="submit">
            Continue
          </button>
        </form>
        <p className="login-footnote">
          Use the email you submitted a talk with to see that submission&apos;s status and tasks.
        </p>
      </main>
    </div>
  );
}
