/**
 * Same-origin gating for state-changing browser posts.
 *
 * Why this exists (Greptile #76 issue 1): `SameSite=Lax` bounds when a cookie is
 * **sent**, not who may **set** one. A cross-origin top-level form POST is a
 * "simple request" — no CORS preflight — so an attacker's page can post
 * credentials to our login route and, if it succeeds, silently replace the
 * victim's session with the attacker's. Everything the victim does afterwards
 * (profile edits, task answers, submissions) lands in the attacker's account.
 *
 * The JSON mode is reachable the same way, so it is gated identically: a
 * `<form enctype="text/plain">` can be crafted to produce a body that parses as
 * JSON, which is exactly the preflight-free bypass a content-type check alone
 * would miss.
 *
 * This module is pure — no `Request`, no environment — so the policy is testable
 * on its own.
 */

export type RequestOriginVerdict = "same-origin" | "cross-origin" | "missing";

/** Normalize any absolute URL or origin string to a canonical origin, or null. */
export function normalizeOrigin(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  // A sandboxed iframe, a `data:` document, and a redirected cross-origin post
  // all serialize their origin as the literal "null". It is never ours.
  if (candidate === "null") return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** First entry of a possibly comma-joined proxy header, with nothing weird in it. */
function firstHeaderValue(value: string | null | undefined): string | null {
  const candidate = value?.split(",")[0]?.trim();
  if (!candidate || /[\s/\\]/.test(candidate)) return null;
  return candidate;
}

function originFromHost(host: string | null, proto: string | null): string | null {
  if (!host) return null;
  const scheme = proto === "http" || proto === "https" ? proto : null;
  // Without a proto signal, try both: a deployment terminating TLS upstream and
  // a local `next start` differ only in the scheme, and the host is what the
  // browser actually addressed.
  const schemes = scheme ? [scheme] : ["https", "http"];
  for (const candidate of schemes) {
    const normalized = normalizeOrigin(`${candidate}://${host}`);
    if (normalized) return normalized;
  }
  return null;
}

/**
 * Every origin this request may legitimately have come from.
 *
 * The host headers are the primary signal and are sound against the threat this
 * guards: a browser sets `Host` (and a trusted proxy sets `X-Forwarded-Host`) to
 * the site it is actually addressing, and a page cannot forge either. A
 * configured `APP_URL` is added rather than substituted, so a deployment
 * reachable under more than one hostname keeps working.
 */
export function expectedRequestOrigins(input: {
  requestUrl: string;
  host?: string | null;
  forwardedHost?: string | null;
  forwardedProto?: string | null;
  appUrl?: string | null;
}): string[] {
  const proto = firstHeaderValue(input.forwardedProto)?.toLowerCase() ?? null;
  const candidates = [
    originFromHost(firstHeaderValue(input.forwardedHost), proto),
    originFromHost(firstHeaderValue(input.host), proto),
    normalizeOrigin(input.requestUrl),
    normalizeOrigin(input.appUrl),
  ];
  return [...new Set(candidates.filter((value): value is string => value !== null))];
}

/**
 * Classify a request's browser-declared origin.
 *
 * `Origin` is preferred; `Referer`'s origin is the documented fallback for the
 * handful of navigations that omit `Origin`. Neither header is settable by the
 * attacking page, which is what makes this a real check rather than a ritual.
 */
export function classifyRequestOrigin(input: {
  origin?: string | null;
  referer?: string | null;
  expected: readonly string[];
}): RequestOriginVerdict {
  const expected = new Set(input.expected);
  const declared = input.origin?.trim();
  if (declared) {
    const normalized = normalizeOrigin(declared);
    // An unparseable or opaque ("null") Origin is a positive signal of
    // cross-origin, not a missing one.
    return normalized && expected.has(normalized) ? "same-origin" : "cross-origin";
  }
  const referer = input.referer?.trim();
  if (referer) {
    const normalized = normalizeOrigin(referer);
    return normalized && expected.has(normalized) ? "same-origin" : "cross-origin";
  }
  return "missing";
}

/** Only a positively-confirmed same-origin request may change session state. */
export function isSameOriginRequest(verdict: RequestOriginVerdict): boolean {
  return verdict === "same-origin";
}
