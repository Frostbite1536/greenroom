import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ApiError, fromZod } from "@/lib/api/http";
import { diagnosticLabel } from "@/lib/diagnostic-label";
import { forgotPasswordSchema } from "@/types/api";
import { getServerSigningSecret } from "@/lib/server-signing";
import { normalizeLoginEmail } from "@/lib/services/credential-login";
import { PASSWORD_RESET_NEUTRAL_MESSAGE } from "@/lib/services/self-service-auth-copy";
import { publicClientIp } from "@/lib/services/public-submission-rate";
import { enforceSelfServiceAuthRateLimit } from "@/lib/services/self-service-auth-rate";
import {
  PASSWORD_RESET_TOKEN_TTL_MS,
  createPasswordResetToken,
  passwordResetExpiry,
  passwordResetUrl,
} from "@/lib/services/password-reset-token";
import { sendPasswordResetEmail, trustedPasswordResetAppUrl } from "@/lib/comms/password-reset";
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
} from "@/lib/api/auth-request";

/**
 * Request a password reset (D-C5-16 item 2).
 *
 * **This endpoint has exactly one success response, and it is the same bytes
 * whether or not the address belongs to an account.** Password reset is the
 * classic account oracle: it is reachable by anyone, it takes a bare address,
 * and a product that answers "no such account" has published its whole user
 * list to anyone willing to iterate. So every well-formed request is answered
 * `NEUTRAL_MESSAGE` — no code path, no branch, and no failure inside the send
 * can change that.
 *
 * This is deliberately the OPPOSITE call from `app/api/auth/signup/route.ts`,
 * which answers a taken address with a distinct 409. The reasoning for both
 * lives in that route's header; the short version is that a signup oracle is
 * cheap to obtain elsewhere and expensive to hide, while a reset oracle is the
 * real thing and free to close.
 *
 * What is honestly NOT hidden: response **timing**. An address with a credential
 * pays a dispatch row and a provider call; one without pays neither. Equalising
 * that would mean either dispatching mail for addresses that do not exist or
 * padding every request to the slowest path, and neither is worth its cost here
 * — the durable per-address and per-IP buckets bound how much an attacker can
 * measure. Stated rather than papered over.
 *
 * A user with no `passwordHash` (the demo personas, and every provisioned
 * account that never set one) gets no mail: there is no credential to sign a
 * token against. The response is the same neutral sentence.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FORM_PATH = "/forgot";

/**
 * The one success response. Both what it says and what it carefully does not:
 * no "we sent", no "if that address exists we sent" hedge that still confirms
 * the check ran differently — one flat statement of what happens next. Shared
 * with the page so the browser outcome and the API outcome are the same bytes.
 */
function neutral(req: Request, formEncoded: boolean): Response {
  if (formEncoded) return noStore(authRedirect(req, `${FORM_PATH}?sent=1`));
  return noStore(NextResponse.json(
    { ok: true, data: { message: PASSWORD_RESET_NEUTRAL_MESSAGE } },
    { status: 200 },
  ));
}

export async function POST(req: Request): Promise<Response> {
  const formEncoded = isFormEncoded(req);
  if (!isSameOriginAuthRequest(req)) return refuseCrossOrigin(req, formEncoded, FORM_PATH);

  const fields = await readAuthFields(req, "forgot", formEncoded);
  const email = normalizeLoginEmail(fields.email);

  try {
    await enforceSelfServiceAuthRateLimit({ intent: "forgot", email, clientIp: publicClientIp(req.headers) });
  } catch (error) {
    if (error instanceof ApiError && error.status === 429) return refuseThrottled(req, formEncoded, FORM_PATH, error);
    if (error instanceof ApiError) return refuseUnavailable(req, formEncoded, FORM_PATH, error);
    console.error("[forgot] throttle unavailable", diagnosticLabel(error));
    return refuseUnavailable(req, formEncoded, FORM_PATH, new ApiError(503, "RESET_UNAVAILABLE", "Password reset is temporarily unavailable."));
  }

  // Shape only. Rejecting "not an email address" reveals nothing about any
  // account, and answering it neutrally would leave someone staring at an inbox
  // because of a typo they could have been told about.
  const parsed = forgotPasswordSchema.safeParse({ email });
  if (!parsed.success) {
    const error = fromZod(parsed.error);
    if (formEncoded) return noStore(authRedirect(req, `${FORM_PATH}?error=invalid`));
    return noStore(authFail(error.status, { code: error.code, message: error.message, fieldErrors: error.fieldErrors }));
  }

  // Everything from here is best-effort and cannot change the response. The
  // whole body is wrapped so that a database hiccup, a missing secret, or a
  // provider outage all still answer the same sentence.
  try {
    await maybeSendResetLink(parsed.data.email);
  } catch (error) {
    console.error("[forgot] reset link could not be prepared", diagnosticLabel(error));
  }
  return neutral(req, formEncoded);
}

/**
 * Mint and send, or do nothing at all. Awaited by the caller, not
 * fire-and-forget: on serverless, work that outlives the response is not
 * guaranteed to run — the convention `lib/comms/notify-service.ts` states.
 */
async function maybeSendResetLink(email: string): Promise<void> {
  const secret = getServerSigningSecret();
  const appUrl = trustedPasswordResetAppUrl();
  if (!secret || !appUrl) return;

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true, passwordHash: true },
  });
  // No account, or an account with no credential to sign a token against.
  if (!user?.passwordHash) return;

  const expiresAt = passwordResetExpiry();
  const token = createPasswordResetToken({ userId: user.id, passwordHash: user.passwordHash, expiresAt }, secret);
  await sendPasswordResetEmail({
    to: user.email,
    name: user.name,
    userId: user.id,
    resetUrl: passwordResetUrl(appUrl, token),
    minutes: Math.round(PASSWORD_RESET_TOKEN_TTL_MS / 60_000),
  });
}
