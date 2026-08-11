import { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/auth";
import type { ApiError } from "@/lib/api/http";
import { diagnosticLabel } from "@/lib/diagnostic-label";
import { parseBoundedText } from "@/lib/api/bounded-json";
import {
  classifyRequestOrigin,
  expectedRequestOrigins,
  isSameOriginRequest,
} from "@/lib/services/request-origin";

/**
 * Shared request mechanics for the self-service auth routes (D-C5-16 item 2).
 *
 * `/signup`, `/forgot` and `/reset` are the same kind of endpoint as
 * `/api/auth/login`: a public POST that both a plain HTML form and an API client
 * must be able to drive, that changes session state, and that must never leak
 * why it refused. Rather than copy that route's mechanics three more times, the
 * parts that are genuinely identical live here.
 *
 * `app/api/auth/login/route.ts` deliberately still owns its own copies. Its
 * contract test pins the exact bytes of that file — the origin gate's position
 * relative to the throttle, the single 401 construction site, the shape of every
 * `console` call — so rewriting it to import from here would trade a verified
 * boundary for a tidier diff on the night before a freeze. Folding login into
 * this module is a named follow-up, not this lane's work.
 *
 * Every helper here is the conservative direction: a body that cannot be parsed
 * yields empty fields (never an exception the caller might answer differently),
 * and only a positively-confirmed same-origin request is ever treated as ours.
 */

/** These bodies are a handful of short fields; anything larger is not one. */
export const AUTH_BODY_MAX_BYTES = 4 * 1024;

export function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export function isFormEncoded(req: Request): boolean {
  const contentType = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  return contentType === "application/x-www-form-urlencoded";
}

/**
 * Both modes are gated, and callers must run this before reading the body: a
 * request that cannot prove it came from this site reaches neither the throttle,
 * the parser, nor an identity.
 *
 * `SameSite=Lax` bounds when a cookie is **sent**, not who may **set** one, so
 * without this a cross-origin form post could hand a victim's browser a session
 * — or, on `/reset`, spend a token the attacker phished. Missing and mismatched
 * are treated alike: every modern browser sends `Origin` on a POST.
 */
export function isSameOriginAuthRequest(req: Request): boolean {
  return isSameOriginRequest(classifyRequestOrigin({
    origin: req.headers.get("origin"),
    referer: req.headers.get("referer"),
    expected: expectedRequestOrigins({
      requestUrl: req.url,
      host: req.headers.get("host"),
      forwardedHost: req.headers.get("x-forwarded-host"),
      forwardedProto: req.headers.get("x-forwarded-proto"),
      appUrl: process.env.APP_URL,
    }),
  }));
}

/**
 * Read the submitted fields. **Never throws.**
 *
 * A malformed, oversized, or absent body yields empty strings for every field,
 * which the throttle still charges and the caller still refuses through its
 * normal path. A parse failure must not be a different observable outcome from
 * a wrong guess. The diagnostic is a bounded label only — these bodies carry
 * passwords and reset tokens, so neither they nor an exception's message may
 * ever reach a log.
 */
export async function readAuthFields(
  req: Request,
  label: string,
  formEncoded: boolean,
  maxBytes = AUTH_BODY_MAX_BYTES,
): Promise<Record<string, string>> {
  const asString = (value: unknown): string => (typeof value === "string" ? value : "");
  try {
    const text = await parseBoundedText(req, maxBytes, "INVALID_REQUEST", "Request could not be read.");
    if (formEncoded) {
      const params = new URLSearchParams(text);
      return Object.fromEntries([...params.keys()].map((key) => [key, params.get(key) ?? ""]));
    }
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [key, asString(value)]),
    );
  } catch (error) {
    console.warn(`[${label}] request body rejected`, diagnosticLabel(error));
    return {};
  }
}

/**
 * Same-origin form navigation, so the request's own origin is the correct base.
 * Nothing here is redeemed from an untrusted link.
 */
export function authRedirect(req: Request, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, req.url), 303);
}

/**
 * The one cross-origin refusal, shaped exactly like the login route's.
 *
 * Deliberately a distinct 403 rather than each route's own generic refusal: it
 * is decided before any identity is looked at or any body is trusted, so it is
 * byte-identical whether an address exists or not and can never become an
 * account oracle. Naming the real cause saves an API client from chasing a
 * credential bug that is actually a missing header.
 */
export const CROSS_ORIGIN_CODE = "CROSS_ORIGIN_REFUSED";
export const CROSS_ORIGIN_MESSAGE =
  "This must be submitted from this site. Send an Origin header matching this deployment.";

export function refuseCrossOrigin(req: Request, formEncoded: boolean, formPath: string): Response {
  if (formEncoded) return noStore(authRedirect(req, `${formPath}?error=blocked`));
  return noStore(NextResponse.json(
    { ok: false, error: { code: CROSS_ORIGIN_CODE, message: CROSS_ORIGIN_MESSAGE } },
    { status: 403 },
  ));
}

/** The locked `ApiResponse` failure shape, as a `NextResponse` so cookies compose. */
export function authFail(
  status: number,
  error: { code: string; message: string; fieldErrors?: Record<string, string[]>; retryAfterSeconds?: number },
): NextResponse {
  const response = NextResponse.json({ ok: false, error }, { status });
  if (error.retryAfterSeconds !== undefined) {
    response.headers.set("Retry-After", String(error.retryAfterSeconds));
  }
  return response;
}

export function refuseThrottled(req: Request, formEncoded: boolean, formPath: string, error: ApiError): Response {
  const retryAfter = Math.max(1, Math.ceil(error.retryAfterSeconds ?? 1));
  if (formEncoded) return noStore(authRedirect(req, `${formPath}?error=throttled&retryAfter=${retryAfter}`));
  return noStore(authFail(429, { code: error.code, message: error.message, retryAfterSeconds: retryAfter }));
}

export function refuseUnavailable(req: Request, formEncoded: boolean, formPath: string, error: ApiError): Response {
  if (formEncoded) return noStore(authRedirect(req, `${formPath}?error=unavailable`));
  return noStore(authFail(503, { code: error.code, message: error.message }));
}

/**
 * The ONE place these routes issue a session cookie.
 *
 * Byte-identical attributes to `app/login/actions.ts` and the credential login
 * route, imported from `lib/auth` rather than restated: `httpOnly` so script
 * cannot read it, `SameSite=Lax` so it is not sent on cross-site subrequests,
 * `Secure` in production, and the single shared TTL. A caller supplies only the
 * signed value — real session or pending identity — so the two variants can
 * never drift apart in how they are stored.
 */
export function setSessionCookie<T extends NextResponse>(response: T, signedValue: string): T {
  response.cookies.set(SESSION_COOKIE, signedValue, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
    secure: process.env.NODE_ENV === "production",
  });
  return response;
}
