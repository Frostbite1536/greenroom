import { NextResponse } from "next/server";
import { encodeSession, getPendingIdentity, homeForRole } from "@/lib/auth";
import { diagnosticLabel } from "@/lib/diagnostic-label";
import { pickCredentialMembership } from "@/lib/services/credential-login";
import {
  isFormEncoded,
  isSameOriginAuthRequest,
  noStore,
  authFail,
  authRedirect,
  refuseCrossOrigin,
  setSessionCookie,
} from "@/lib/api/auth-request";

/**
 * Exchange a pending identity for a real session (D-C5-16 item 2).
 *
 * The case this exists for: someone signed up, has no event of their own, and an
 * organizer has since added them to theirs. `/welcome` tells people to "ask an
 * organizer to add you", and without this that advice dead-ends — the pending
 * cookie carries no event, so every workspace surface would still bounce them to
 * `/login` even though they now have somewhere to go. Making them re-enter the
 * password they set two minutes ago would be the product forgetting who they are.
 *
 * It is deliberately narrow:
 * - It grants nothing. The membership must already exist in the database;
 *   `getPendingIdentity` re-reads it on every call, and `pickCredentialMembership`
 *   — the same chooser credential login uses — decides where they land. Nothing
 *   is taken from the request body, which is not even read.
 * - It is same-origin gated like every other session-changing post here.
 * - There is no throttle. Unlike signup, forgot and reset, this endpoint is not
 *   reachable without an already-valid signed cookie, reads no submitted
 *   address, and cannot create, send, or guess anything. There is nothing here
 *   for a bucket to bound.
 * - No membership yet means no session: the caller goes back to `/welcome` with
 *   the pending cookie they already had, untouched.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FORM_PATH = "/welcome";

export async function POST(req: Request): Promise<Response> {
  const formEncoded = isFormEncoded(req);
  if (!isSameOriginAuthRequest(req)) return refuseCrossOrigin(req, formEncoded, FORM_PATH);

  try {
    const pending = await getPendingIdentity();
    if (!pending) {
      if (formEncoded) return noStore(authRedirect(req, "/login"));
      return noStore(authFail(401, { code: "UNAUTHENTICATED", message: "Sign in to continue." }));
    }

    const membership = pickCredentialMembership(pending.memberships);
    if (!membership) {
      if (formEncoded) return noStore(authRedirect(req, FORM_PATH));
      return noStore(NextResponse.json(
        { ok: true, data: { redirectTo: FORM_PATH, pending: true } },
        { status: 200 },
      ));
    }

    const home = homeForRole(membership.role);
    const signed = encodeSession({ user: pending.user, event: membership.event, role: membership.role });
    const response = formEncoded
      ? authRedirect(req, home)
      : NextResponse.json({ ok: true, data: { redirectTo: home, pending: false } }, { status: 200 });
    return noStore(setSessionCookie(response, signed));
  } catch (error) {
    console.error("[continue] session could not be issued", diagnosticLabel(error));
    if (formEncoded) return noStore(authRedirect(req, FORM_PATH));
    return noStore(authFail(503, { code: "CONTINUE_UNAVAILABLE", message: "This is temporarily unavailable. Try again shortly." }));
  }
}
