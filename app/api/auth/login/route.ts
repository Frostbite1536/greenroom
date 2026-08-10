import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, encodeSession, homeForRole, type DemoSession } from "@/lib/auth";
import { ApiError } from "@/lib/api/http";
import { diagnosticLabel } from "@/lib/diagnostic-label";
import { parseBoundedText } from "@/lib/api/bounded-json";
import { publicClientIp } from "@/lib/services/public-submission-rate";
import { enforceLoginRateLimit } from "@/lib/services/login-rate";
import {
  classifyRequestOrigin,
  expectedRequestOrigins,
  isSameOriginRequest,
} from "@/lib/services/request-origin";
import {
  normalizeLoginEmail,
  normalizeLoginPassword,
  resolveCredentialSession,
} from "@/lib/services/credential-login";

/**
 * Credential sign-in (D-C5-6 ruling 2).
 *
 * One POST path serves both callers: the login page's plain HTML form (which
 * needs redirects) and an API client (which needs status codes). The mode is
 * chosen by the request's own content type — form-encoded gets 303s back to
 * `/login`, everything else gets the locked `ApiResponse` shape.
 *
 * Invariants:
 * - A session is issued only for a **positively confirmed same-origin** post.
 *   `SameSite=Lax` bounds when a cookie is sent, not who may set one, so
 *   without this a cross-origin form post could silently replace the victim's
 *   session with the attacker's. Both modes are gated: a `text/plain` form can
 *   be crafted into a valid JSON body, so gating only the form mode would leave
 *   a preflight-free bypass.
 * - The throttle is charged **before** any `User` row is read, so an unknown
 *   address consumes exactly the same budget as a real one.
 * - Unknown email, wrong password, a user without a credential, and a
 *   credentialed user without a membership are one indistinguishable refusal:
 *   `401 INVALID_CREDENTIALS` (or `?error=invalid` for the form).
 * - The issued session is byte-identical in shape to the persona flow's, with
 *   the role resolved from the user's own `EventMember` rows. Session and
 *   cookie mechanics are untouched — `encodeSession` and `SESSION_COOKIE` are
 *   imported, not reimplemented.
 * - Nothing here logs the request body, the submitted address, or the password.
 *
 * There is no self-registration and no password reset: credentials exist only
 * for seeded and organizer-provisioned users.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A credential post is two short fields; anything larger is not one. */
export const LOGIN_BODY_MAX_BYTES = 4 * 1024;

const INVALID_CREDENTIALS_CODE = "INVALID_CREDENTIALS";
const INVALID_CREDENTIALS_MESSAGE = "Email or password is incorrect.";

/**
 * Deliberately a **distinct 403, not the generic 401.**
 *
 * The indistinguishability rule exists to stop this route becoming an account
 * oracle. This refusal happens before any identity is looked at or any body is
 * trusted, so it is byte-identical whether the address exists, does not, or is
 * absent — a separate code leaks nothing about any account. Folding it into the
 * 401 would only cost: an API client missing a header would be told its
 * password was wrong and would chase a credential bug instead of the real
 * cause. The message names the fix for exactly that reason.
 */
const CROSS_ORIGIN_CODE = "CROSS_ORIGIN_REFUSED";
const CROSS_ORIGIN_MESSAGE =
  "Sign-in must be submitted from this site. Send an Origin header matching this deployment.";

function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

function isFormEncoded(req: Request): boolean {
  const contentType = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  return contentType === "application/x-www-form-urlencoded";
}

/**
 * Never throws. A malformed, oversized, or absent body yields empty fields,
 * which the throttle still charges and the resolver still refuses generically —
 * a parse failure must not be a different observable outcome from a bad guess.
 */
async function readAttempt(req: Request, formEncoded: boolean): Promise<{ email: string; password: string }> {
  try {
    const text = await parseBoundedText(req, LOGIN_BODY_MAX_BYTES, INVALID_CREDENTIALS_CODE, INVALID_CREDENTIALS_MESSAGE);
    if (formEncoded) {
      const params = new URLSearchParams(text);
      return { email: normalizeLoginEmail(params.get("email")), password: normalizeLoginPassword(params.get("password")) };
    }
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { email: "", password: "" };
    const body = parsed as Record<string, unknown>;
    return { email: normalizeLoginEmail(body.email), password: normalizeLoginPassword(body.password) };
  } catch (error) {
    // Bounded label only: this body is a credential, so neither it nor the
    // exception's message may reach a log. The outcome is unchanged — empty
    // fields take the same generic refusal a bad guess takes.
    console.warn("[login] request body rejected", diagnosticLabel(error));
    return { email: "", password: "" };
  }
}

function loginRedirect(req: Request, path: string): NextResponse {
  // Same-origin form navigation, so the request's own origin is the correct
  // base. Unlike the reviewer-invite bearer flow, nothing here is redeemed from
  // an untrusted link.
  return NextResponse.redirect(new URL(path, req.url), 303);
}

function refuse(req: Request, formEncoded: boolean): Response {
  if (formEncoded) return noStore(loginRedirect(req, "/login?error=invalid"));
  return noStore(NextResponse.json(
    { ok: false, error: { code: INVALID_CREDENTIALS_CODE, message: INVALID_CREDENTIALS_MESSAGE } },
    { status: 401 },
  ));
}

function refuseCrossOrigin(req: Request, formEncoded: boolean): Response {
  if (formEncoded) return noStore(loginRedirect(req, "/login?error=blocked"));
  return noStore(NextResponse.json(
    { ok: false, error: { code: CROSS_ORIGIN_CODE, message: CROSS_ORIGIN_MESSAGE } },
    { status: 403 },
  ));
}

function refuseThrottled(req: Request, formEncoded: boolean, error: ApiError): Response {
  const retryAfter = Math.max(1, Math.ceil(error.retryAfterSeconds ?? 1));
  if (formEncoded) {
    return noStore(loginRedirect(req, `/login?error=throttled&retryAfter=${retryAfter}`));
  }
  const response = NextResponse.json(
    { ok: false, error: { code: error.code, message: error.message, retryAfterSeconds: retryAfter } },
    { status: 429 },
  );
  response.headers.set("Retry-After", String(retryAfter));
  return noStore(response);
}

function refuseUnavailable(req: Request, formEncoded: boolean, error: ApiError): Response {
  if (formEncoded) return noStore(loginRedirect(req, "/login?error=unavailable"));
  return noStore(NextResponse.json({ ok: false, error: { code: error.code, message: error.message } }, { status: 503 }));
}

function establish(req: Request, formEncoded: boolean, session: DemoSession): Response {
  const home = homeForRole(session.role);
  const response = formEncoded
    ? loginRedirect(req, home)
    : NextResponse.json({ ok: true, data: { redirectTo: home, role: session.role } }, { status: 200 });
  response.cookies.set(SESSION_COOKIE, encodeSession(session), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
    secure: process.env.NODE_ENV === "production",
  });
  return noStore(response);
}

async function findCredentialUser(email: string) {
  return prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      passwordHash: true,
      memberships: { select: { role: true, event: { select: { id: true, name: true, slug: true } } } },
    },
  });
}

/**
 * Both modes are gated, and this runs before the body is read: a request that
 * cannot prove it came from this site never reaches the throttle, the parser,
 * or an identity. Missing and mismatched are treated alike — every modern
 * browser sends `Origin` on a POST, so an absent one is not a browser, and
 * being lenient there would reopen the hole for anything that omits it.
 */
function originVerdict(req: Request) {
  return classifyRequestOrigin({
    origin: req.headers.get("origin"),
    referer: req.headers.get("referer"),
    expected: expectedRequestOrigins({
      requestUrl: req.url,
      host: req.headers.get("host"),
      forwardedHost: req.headers.get("x-forwarded-host"),
      forwardedProto: req.headers.get("x-forwarded-proto"),
      appUrl: process.env.APP_URL,
    }),
  });
}

export async function POST(req: Request): Promise<Response> {
  const formEncoded = isFormEncoded(req);
  if (!isSameOriginRequest(originVerdict(req))) return refuseCrossOrigin(req, formEncoded);

  const attempt = await readAttempt(req, formEncoded);

  try {
    // Charged first and unconditionally: this is what stops the throttle from
    // becoming an account oracle, and what makes the refusals below cheap.
    await enforceLoginRateLimit({ email: attempt.email, clientIp: publicClientIp(req.headers) });
  } catch (error) {
    if (error instanceof ApiError && error.status === 429) return refuseThrottled(req, formEncoded, error);
    if (error instanceof ApiError) return refuseUnavailable(req, formEncoded, error);
    // Never include the body, the address, or the password in a diagnostic.
    console.error("[login] throttle unavailable", diagnosticLabel(error));
    return refuseUnavailable(req, formEncoded, new ApiError(503, "LOGIN_UNAVAILABLE", "Sign-in is temporarily unavailable."));
  }

  try {
    const session = await resolveCredentialSession({
      email: attempt.email,
      password: attempt.password,
      findUser: findCredentialUser,
    });
    if (!session) return refuse(req, formEncoded);
    return establish(req, formEncoded, session);
  } catch (error) {
    console.error("[login] attempt could not be completed", diagnosticLabel(error));
    return refuseUnavailable(req, formEncoded, new ApiError(503, "LOGIN_UNAVAILABLE", "Sign-in is temporarily unavailable."));
  }
}
