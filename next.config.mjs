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

/** Applies everywhere, including `/embed/*`. */
const BASELINE_SECURITY_HEADERS = [
  // Never let a browser re-interpret a response as a type we did not send.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Full URL to same origin, bare origin cross-origin, nothing over a downgrade:
  // abstract and review permalinks carry ids that third parties have no claim to.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The app asks for none of these; say so, so an injected frame cannot either.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

/**
 * Everything except `/embed/...`. path-to-regexp negative lookahead, the same
 * form Next documents for matchers: `/` and `/admin/speakers` match,
 * `/embed/schedule` does not.
 */
const NON_EMBED_SOURCE = "/((?!embed/).*)";

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  turbopack: { root: process.cwd() },
  async headers() {
    return [
      { source: "/:path*", headers: BASELINE_SECURITY_HEADERS },
      {
        source: NON_EMBED_SOURCE,
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'none'" }],
      },
    ];
  },
};

export default nextConfig;
