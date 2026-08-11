import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Mic2 } from "lucide-react";
import { getPendingIdentity, getResolvedSession, homeForRole } from "@/lib/auth";
import { NewEventDialog } from "@/components/new-event-dialog";
import { logout } from "@/app/login/actions";

export const metadata: Metadata = { title: "Welcome" };

export const dynamic = "force-dynamic";

/**
 * Where a signed-in person with no event membership lands (D-C5-16 item 2).
 *
 * ## What used to happen here
 *
 * Nothing good, and it was never reachable before this lane because
 * `resolveCredentialSession` refuses a membership-less identity outright
 * (`lib/services/credential-login.ts` — "A credentialed identity with no
 * membership has nowhere to land"). Self-service signup creates exactly such an
 * identity, and had it been issued an ordinary session cookie the result would
 * have been a silent dead end rather than a redirect loop: `getResolvedSession`
 * returns null without a matching `EventMember`, so `requireSession` bounces
 * every workspace page to `/login`, and `/login` — which asks the same resolver
 * — sees null too and simply renders the sign-in form again. The cookie is set,
 * the person is authenticated, and the product shows them the door they just
 * came through with no explanation. That is the state this page exists to
 * replace.
 *
 * ## The two ways out
 *
 * Create an event (the dialog below issues a real ADMIN session as part of the
 * same request that commits it), or be added to someone else's. The second is
 * why the Continue form exists: without it, "ask an organizer to add you" would
 * be advice this page could not honour.
 */
export default async function WelcomePage() {
  // A real session means real memberships — there is nothing for them here.
  const session = await getResolvedSession();
  if (session) redirect(homeForRole(session.role));

  const pending = await getPendingIdentity();
  if (!pending) redirect("/login");

  const invited = pending.memberships.length > 0;

  return (
    <div className="login-screen">
      <main className="login-card">
        <div className="brand login-brand">
          <span className="brand-mark">
            <Mic2 size={18} aria-hidden="true" />
          </span>
          <span>Greenroom</span>
        </div>
        <h1>You&rsquo;re signed in</h1>
        <p className="login-hint">
          Signed in as {pending.user.email}. Create an event to get started, or ask an organizer to
          add you to theirs.
        </p>

        {invited ? (
          <>
            <p className="login-note" role="status">
              You have been added to an event. Continue to open your workspace.
            </p>
            {/* Plain form post, same as the login page: no JavaScript required,
                and the server re-checks the membership before issuing anything. */}
            <form method="post" action="/api/auth/continue">
              <button className="button primary login-submit" type="submit">
                <ArrowRight size={16} aria-hidden="true" />
                Continue to your workspace
              </button>
            </form>
            <div className="login-divider" role="separator">
              <span>or</span>
            </div>
          </>
        ) : null}

        <p className="login-hint">
          An event of your own starts empty — your forms, your programme, your speakers. You become
          its organizer as soon as it is created.
        </p>
        <NewEventDialog onboarding />

        <p className="login-note">
          Waiting on an invitation? Nothing to do — ask your organizer to add {pending.user.email},
          then reload this page. Or <Link href="/login">sign in</Link> as someone else.
        </p>
        <form action={logout}>
          <button className="ghost-button" type="submit">Sign out</button>
        </form>
      </main>
    </div>
  );
}
