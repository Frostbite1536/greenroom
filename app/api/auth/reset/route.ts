import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encodePendingSession, encodeSession, homeForRole } from "@/lib/auth";
import { ApiError, fromZod } from "@/lib/api/http";
import { diagnosticLabel } from "@/lib/diagnostic-label";
import { passwordResetSchema } from "@/types/api";
import { hashPassword } from "@/lib/password-credential";
import { checkNewPassword } from "@/lib/services/password-policy";
import { pickCredentialMembership } from "@/lib/services/credential-login";
import { publicClientIp } from "@/lib/services/public-submission-rate";
import { enforceSelfServiceAuthRateLimit } from "@/lib/services/self-service-auth-rate";
import { resolvePasswordResetToken } from "@/lib/services/password-reset-redeem";
import { PASSWORD_RESET_INVALID_TOKEN_MESSAGE } from "@/lib/services/self-service-auth-copy";
import {
  isFormEncoded,
  isSameOriginAuthRequest,
  noStore,
  authFail,
  authRedirect,
  readAuthFields,
  refuseCrossOrigin,
  refuseThrottled,
  refuseUnavailable,
  setSessionCookie,
} from "@/lib/api/auth-request";

/**
 * Redeem a reset token and set a new password (D-C5-16 item 2).
 *
 * Invariants:
 * - Only a **positively confirmed same-origin** post may spend a token. Without
 *   this, a page that phished a link out of someone's inbox could set a password
 *   the attacker chose.
 * - The throttle is charged before the token is resolved.
 * - Invalid, expired, already-spent, and never-valid are ONE refusal with one
 *   message — `resolvePasswordResetToken` collapses them deliberately, and this
 *   route must not re-introduce a distinction.
 * - The write is `passwordHash` only. A reset does not touch memberships, roles,
 *   or profile — it is a credential change, and anything else would make a
 *   phished link more valuable than it already is.
 * - Spending the token invalidates it by construction: the signature is derived
 *   from the stored hash, so writing a new hash makes this token, and every
 *   other token minted against the old one, stop verifying. No `usedAt` column.
 *
 * After a successful change the person is signed in the same way credential
 * login signs anyone in — `pickCredentialMembership` chooses the landing
 * membership, `encodeSession` signs it, and `setSessionCookie` stores it with
 * the identical attributes. An account with no membership yet takes the pending
 * variant and lands on `/welcome`, exactly as signup does.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FORM_PATH = "/reset";
const INVALID_TOKEN_CODE = "RESET_TOKEN_INVALID";

/**
 * One calm sentence for every way a token can fail — shared with the page, so
 * the refusal a browser reads and the refusal an API client reads cannot drift.
 * It names no account, does not say whether the link was used or merely old,
 * and points at the one action that always works.
 */
function refuseToken(req: Request, formEncoded: boolean): Response {
  if (formEncoded) return noStore(authRedirect(req, `${FORM_PATH}?error=token`));
  return noStore(authFail(400, { code: INVALID_TOKEN_CODE, message: PASSWORD_RESET_INVALID_TOKEN_MESSAGE }));
}

export async function POST(req: Request): Promise<Response> {
  const formEncoded = isFormEncoded(req);
  if (!isSameOriginAuthRequest(req)) return refuseCrossOrigin(req, formEncoded, FORM_PATH);

  const fields = await readAuthFields(req, "reset", formEncoded);

  try {
    // No per-address bucket here: the redeemer supplies a token, not an email,
    // and keying a bucket off the token's user id would make the throttle's own
    // behaviour depend on which account the token names.
    await enforceSelfServiceAuthRateLimit({ intent: "reset", email: "", clientIp: publicClientIp(req.headers) });
  } catch (error) {
    if (error instanceof ApiError && error.status === 429) return refuseThrottled(req, formEncoded, FORM_PATH, error);
    if (error instanceof ApiError) return refuseUnavailable(req, formEncoded, FORM_PATH, error);
    console.error("[reset] throttle unavailable", diagnosticLabel(error));
    return refuseUnavailable(req, formEncoded, FORM_PATH, new ApiError(503, "RESET_UNAVAILABLE", "Password reset is temporarily unavailable."));
  }

  const parsed = passwordResetSchema.safeParse({
    token: fields.token ?? "",
    password: fields.password ?? "",
    confirmPassword: fields.confirmPassword ?? "",
  });
  // A token that fails the shape check is refused as a token, not as a
  // validation error, so a malformed one is indistinguishable from an expired
  // one. A missing or short password is a genuine field error.
  if (!parsed.success) {
    const error = fromZod(parsed.error);
    if (error.fieldErrors?.token) return refuseToken(req, formEncoded);
    return refuseInvalid(req, formEncoded, error, fields.token ?? "");
  }
  const policy = checkNewPassword(parsed.data.password, parsed.data.confirmPassword);
  if (!policy.ok) {
    return refuseInvalid(
      req,
      formEncoded,
      new ApiError(422, "VALIDATION_ERROR", "Request validation failed.", policy.fieldErrors),
      parsed.data.token,
    );
  }

  try {
    const resolved = await resolvePasswordResetToken(parsed.data.token);
    if (!resolved) return refuseToken(req, formEncoded);

    const passwordHash = await hashPassword(policy.password);
    await prisma.user.update({ where: { id: resolved.user.id }, data: { passwordHash } });

    const membership = pickCredentialMembership(resolved.memberships);
    const home = membership ? homeForRole(membership.role) : "/welcome";
    const signed = membership
      ? encodeSession({ user: resolved.user, event: membership.event, role: membership.role })
      : encodePendingSession(resolved.user);
    const response = formEncoded
      ? authRedirect(req, home)
      : NextResponse.json({ ok: true, data: { redirectTo: home, pending: !membership } }, { status: 200 });
    return noStore(setSessionCookie(response, signed));
  } catch (error) {
    console.error("[reset] password could not be changed", diagnosticLabel(error));
    return refuseUnavailable(req, formEncoded, FORM_PATH, new ApiError(503, "RESET_UNAVAILABLE", "Password reset is temporarily unavailable."));
  }
}

/**
 * 422 with field-scoped messages.
 *
 * The form mode carries the token back in the redirect. It arrived in a URL and
 * it goes back into one — no new exposure — and without it a mistyped
 * confirmation would strand someone on a page with no way to try again but to
 * dig the original email out of their inbox.
 */
function refuseInvalid(req: Request, formEncoded: boolean, error: ApiError, token: string): Response {
  if (formEncoded) {
    const query = token ? `?error=invalid&token=${encodeURIComponent(token)}` : "?error=invalid";
    return noStore(authRedirect(req, `${FORM_PATH}${query}`));
  }
  return noStore(authFail(error.status, { code: error.code, message: error.message, fieldErrors: error.fieldErrors }));
}
