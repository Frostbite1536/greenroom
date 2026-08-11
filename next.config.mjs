/**
 * GRA2-08 — baseline security headers, route-aware.
 *
 * Deliberately NOT a full Content-Security-Policy: `script-src`/`style-src` on
 * a Next app needs measured nonce work and a real migration, and shipping a
 * half-measured one breaks the app instead of defending it. What is here is the
 * set that costs nothing to be right about.
 *
 * The one route-dependent header is framing. `/embed/*` exists to be put in
 * somebody else's page — `docs/judging/embed-schedule-proof.html` loads
 * `/embed/schedule` in an iframe from a different origin — so a blanket
 * `frame-ancestors 'none'` would break the product's own embed feature. The
 * embed paths are therefore EXCLUDED from the frame-ancestors rule rather than
 * given a second, more permissive one: two matching rules for the same header
 * would emit two CSP headers, and a browser enforces the intersection of them,
 * which is the restrictive one — silently breaking embeds while looking correct.
 */

/** Applies everywhere, including `/embed/*` and `/api/*`. */
const UNIVERSAL_SECURITY_HEADERS = [
  // Never let a browser re-interpret a response as a type we did not send.
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

/**
 * Document-only headers. API routes are excluded on purpose: several security
 * routes set a STRICTER Referrer-Policy of their own (the reviewer-invite
 * surface sends `no-referrer` because its URLs carry bearer material), and a
 * config-level value on the same header would override or duplicate the
 * handler's — `no-referrer, strict-origin-when-cross-origin` is not a policy
 * any check or browser should have to disentangle. Documents get the baseline;
 * an API route that needs a referrer policy states its own.
 */
const DOCUMENT_SECURITY_HEADERS = [
  // Full URL to same origin, bare origin cross-origin, nothing over a downgrade:
  // abstract and review permalinks carry ids that third parties have no claim to.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The app asks for none of these; say so, so an injected frame cannot either.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/**
 * Everything except `/embed/...` and `/api/...`. path-to-regexp negative
 * lookahead, the same form Next documents for matchers: `/` and
 * `/admin/speakers` match; `/embed/schedule` and `/api/...` do not.
 */
const NON_EMBED_DOCUMENT_SOURCE = "/((?!embed/|api/).*)";
const DOCUMENT_SOURCE = "/((?!api/).*)";

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  turbopack: { root: process.cwd() },
  async headers() {
    return [
      { source: "/:path*", headers: UNIVERSAL_SECURITY_HEADERS },
      { source: DOCUMENT_SOURCE, headers: DOCUMENT_SECURITY_HEADERS },
      {
        source: NON_EMBED_DOCUMENT_SOURCE,
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'none'" }],
      },
    ];
  },
};

export default nextConfig;
