import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { encodePendingSession } from "@/lib/auth";
import { ApiError, fromZod } from "@/lib/api/http";
import { diagnosticLabel } from "@/lib/diagnostic-label";
import { signupSchema } from "@/types/api";
import { hashPassword } from "@/lib/password-credential";
import { checkNewPassword } from "@/lib/services/password-policy";
import { normalizeLoginEmail } from "@/lib/services/credential-login";
import { publicClientIp } from "@/lib/services/public-submission-rate";
import { enforceSelfServiceAuthRateLimit } from "@/lib/services/self-service-auth-rate";
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
 * Public self-service signup (D-C5-16 item 2, superseding D-C5-9's roadmap-only
 * ruling).
 *
 * Shaped after `app/api/auth/login/route.ts`: one POST serving both a plain HTML
 * form (which needs 303s) and an API client (which needs status codes), chosen
 * by the request's own content type. The mechanics they share — origin gate,
 * bounded body read, cookie issuance — are imported from
 * `lib/api/auth-request.ts` rather than copied.
 *
 * Invariants:
 * - Only a **positively confirmed same-origin** post may create an account or
 *   set a cookie. Both modes are gated, before the body is read.
 * - The throttle is charged before any `User` row is read, so a taken address
 *   and a free one consume exactly the same budget.
 * - The password is never logged, never returned, and never leaves this request
 *   except as a scrypt credential.
 * - A new account has no `EventMember` row, so it CANNOT be issued a
 *   `DemoSession` — that type structurally requires an event and a role. It gets
 *   the pending variant of the same signed cookie and lands on `/welcome`.
 *
 * ## The one deliberate enumeration tradeoff
 *
 * A taken address is answered with a distinct **409**, not the generic refusal
 * the rest of the auth surface uses. This is a considered UX-over-enumeration
 * trade, and it is the opposite of the call `/api/auth/forgot` makes:
 *
 * - Signup is not an oracle worth much. Anyone can test whether an address is
 *   registered on almost any product by trying to sign up with it; hiding it
 *   here would mean sending "check your inbox" mail to an address that already
 *   has an account, which is a worse outcome (it teaches people to expect mail
 *   that never comes, and it hands an attacker a free way to mail a stranger).
 * - The cost of hiding it is paid by the honest majority: someone who forgot
 *   they already have an account would be told nothing, and would sit waiting
 *   for a verification email that will never arrive.
 * - Password reset makes the opposite call for the opposite reason — see
 *   `app/api/auth/forgot/route.ts`. That endpoint IS the classic oracle, it
 *   sends mail to an address the requester may not own, and its neutral response
 *   costs an honest person nothing.
 *
 * The refusal copy therefore stays calm and points at the two doors that work:
 * sign in, or reset the password. It never says whether that account has a
 * password, a membership, or a role.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FORM_PATH = "/signup";
const EMAIL_TAKEN_CODE = "EMAIL_TAKEN";
const EMAIL_TAKEN_MESSAGE =
  "An account already uses that email address. Sign in instead, or reset the password if you have forgotten it.";

/**
 * A display name derived from the address, because the form deliberately asks
 * for two fields and not three. `User.name` is required and shows up in the app
 * shell, so an empty string would render as a blank identity everywhere.
 */
export function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const pretty = local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
    .slice(0, 80)
    .trim();
  return pretty || email.slice(0, 80);
}

export async function POST(req: Request): Promise<Response> {
  const formEncoded = isFormEncoded(req);
  if (!isSameOriginAuthRequest(req)) return refuseCrossOrigin(req, formEncoded, FORM_PATH);

  const fields = await readAuthFields(req, "signup", formEncoded);
  // Normalized before the throttle so the bucket key matches the row that would
  // be created; an unusable address becomes "", a stable key that matches no row.
  const email = normalizeLoginEmail(fields.email);

  try {
    await enforceSelfServiceAuthRateLimit({ intent: "signup", email, clientIp: publicClientIp(req.headers) });
  } catch (error) {
    if (error instanceof ApiError && error.status === 429) return refuseThrottled(req, formEncoded, FORM_PATH, error);
    if (error instanceof ApiError) return refuseUnavailable(req, formEncoded, FORM_PATH, error);
    console.error("[signup] throttle unavailable", diagnosticLabel(error));
    return refuseUnavailable(req, formEncoded, FORM_PATH, new ApiError(503, "SIGNUP_UNAVAILABLE", "Sign-up is temporarily unavailable."));
  }

  const parsed = signupSchema.safeParse({
    email,
    password: fields.password ?? "",
    confirmPassword: fields.confirmPassword ?? "",
  });
  if (!parsed.success) return refuseInvalid(req, formEncoded, fromZod(parsed.error));
  const policy = checkNewPassword(parsed.data.password, parsed.data.confirmPassword);
  if (!policy.ok) {
    return refuseInvalid(req, formEncoded, new ApiError(422, "VALIDATION_ERROR", "Request validation failed.", policy.fieldErrors));
  }

  try {
    const passwordHash = await hashPassword(policy.password);
    const user = await prisma.user.create({
      data: { email: parsed.data.email, name: displayNameFromEmail(parsed.data.email), passwordHash },
      select: { id: true, name: true, email: true },
    });

    // A brand-new account is a member of nothing, so the real session type
    // cannot describe it. The pending variant carries the identity and no
    // authority; `/welcome` is the only surface that reads it.
    const signed = encodePendingSession(user);
    const response = formEncoded
      ? authRedirect(req, "/welcome")
      : NextResponse.json({ ok: true, data: { redirectTo: "/welcome", pending: true } }, { status: 201 });
    return noStore(setSessionCookie(response, signed));
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      if (formEncoded) return noStore(authRedirect(req, `${FORM_PATH}?error=taken`));
      return noStore(authFail(409, { code: EMAIL_TAKEN_CODE, message: EMAIL_TAKEN_MESSAGE }));
    }
    // Never the body, the address, or the password: a bounded class only.
    console.error("[signup] account could not be created", diagnosticLabel(error));
    return refuseUnavailable(req, formEncoded, FORM_PATH, new ApiError(503, "SIGNUP_UNAVAILABLE", "Sign-up is temporarily unavailable."));
  }
}

/**
 * 422 with field-scoped messages, per the strict-schema convention. The form
 * mode cannot carry a field map through a redirect, so it names the rule the
 * page already prints beside the input.
 */
function refuseInvalid(req: Request, formEncoded: boolean, error: ApiError): Response {
  if (formEncoded) return noStore(authRedirect(req, `${FORM_PATH}?error=invalid`));
  return noStore(authFail(error.status, { code: error.code, message: error.message, fieldErrors: error.fieldErrors }));
}
