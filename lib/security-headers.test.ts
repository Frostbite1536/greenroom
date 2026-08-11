import assert from "node:assert/strict";
import test from "node:test";

/**
 * GRA2-08 — the baseline security-header matrix, asserted against the real
 * config object rather than a copy of it.
 *
 * `next.config.mjs` is plain JS, so it is imported and inspected. The specifier
 * is built at runtime so TypeScript does not try to resolve a `.mjs` module the
 * project deliberately does not typecheck (`allowJs: false`), and the import is
 * lazy because the test runner transpiles to CJS, where there is no top-level
 * await.
 *
 * What this file CANNOT prove is that Next applies these rules the way the
 * matcher says — that is the smoke's job (`scripts/_frontend-smoke.mjs` asserts
 * the headers on real responses from `/`, an admin page, and `/embed/schedule`).
 * Here we pin the policy; there we pin the delivery.
 */
type HeaderPair = { key: string; value: string };
type HeaderRule = { source: string; headers: HeaderPair[] };
type NextConfigLike = { headers?: () => Promise<HeaderRule[]>; poweredByHeader?: boolean };

const specifier = new URL("../next.config.mjs", import.meta.url).href;

let cache: { config: NextConfigLike; rules: HeaderRule[] } | undefined;

async function load(): Promise<{ config: NextConfigLike; rules: HeaderRule[] }> {
  if (cache) return cache;
  const mod = (await import(specifier)) as { default: NextConfigLike };
  const config = mod.default;
  cache = { config, rules: await (config.headers?.() ?? Promise.resolve([])) };
  return cache;
}

/**
 * A deliberately small stand-in for the two source forms this config uses:
 * `/:path*` (everything) and a `/(regex)` group. Anything else is a new shape
 * that must be reviewed rather than silently mis-asserted.
 */
function matches(source: string, pathname: string): boolean {
  if (source === "/:path*") return true;
  const group = source.match(/^\/\((.*)\)$/);
  assert.ok(group, `unhandled header source shape: ${source}`);
  return new RegExp(`^/(?:${group[1]})$`).test(pathname);
}

/** Every header Next would apply to a path, later rules winning on key. */
function headersFor(rules: HeaderRule[], pathname: string): Map<string, string> {
  const applied = new Map<string, string>();
  for (const rule of rules) {
    if (!matches(rule.source, pathname)) continue;
    for (const { key, value } of rule.headers) applied.set(key.toLowerCase(), value);
  }
  return applied;
}

const SHELL_PATHS = ["/", "/login", "/admin/speakers", "/admin/agenda", "/portal", "/cfp/demo-event/cfp"];
const EMBED_PATHS = ["/embed/schedule", "/embed/speakers", "/embed/schedule/anything"];

test("the config actually declares a headers() rule set", async () => {
  const { config, rules } = await load();
  assert.equal(typeof config.headers, "function");
  assert.ok(rules.length > 0);
  // The pre-existing hardening must survive this change.
  assert.equal(config.poweredByHeader, false);
});

test("every path gets the four baseline headers, embeds included", async () => {
  const { rules } = await load();
  for (const pathname of [...SHELL_PATHS, ...EMBED_PATHS]) {
    const applied = headersFor(rules, pathname);
    assert.equal(applied.get("x-content-type-options"), "nosniff", pathname);
    assert.equal(applied.get("referrer-policy"), "strict-origin-when-cross-origin", pathname);
    assert.equal(applied.get("permissions-policy"), "camera=(), microphone=(), geolocation=()", pathname);
    assert.equal(applied.get("strict-transport-security"), "max-age=31536000; includeSubDomains", pathname);
  }
});

test("the app shell refuses to be framed", async () => {
  const { rules } = await load();
  for (const pathname of SHELL_PATHS) {
    assert.equal(headersFor(rules, pathname).get("content-security-policy"), "frame-ancestors 'none'", pathname);
  }
});

test("embeds stay frameable — the whole reason the policy is route-aware", async () => {
  const { rules } = await load();
  for (const pathname of EMBED_PATHS) {
    const csp = headersFor(rules, pathname).get("content-security-policy");
    // Absent is the intent; a permissive value would also be acceptable, but a
    // restrictive one breaks `docs/judging/embed-schedule-proof.html`.
    assert.ok(
      csp === undefined || /frame-ancestors\s+\*/.test(csp),
      `${pathname} must not be given a restrictive frame-ancestors (got ${String(csp)})`,
    );
  }
});

test("exactly one CSP rule can ever match a path, so no intersection is possible", async () => {
  const { rules } = await load();
  // Two matching CSP rules would emit two headers and browsers enforce their
  // intersection — embeds would break while every rule looked permissive.
  for (const pathname of [...SHELL_PATHS, ...EMBED_PATHS]) {
    const matching = rules.filter(
      (rule) =>
        matches(rule.source, pathname)
        && rule.headers.some((header) => header.key.toLowerCase() === "content-security-policy"),
    );
    assert.ok(matching.length <= 1, `${pathname} matched ${matching.length} CSP rules`);
  }
});

test("no full CSP is smuggled in — script-src is explicitly out of scope", async () => {
  const { rules } = await load();
  for (const rule of rules) {
    for (const header of rule.headers) {
      if (header.key.toLowerCase() !== "content-security-policy") continue;
      assert.equal(header.value, "frame-ancestors 'none'");
      for (const directive of ["script-src", "style-src", "default-src", "connect-src"]) {
        assert.ok(!header.value.includes(directive), `${directive} needs a measured migration, not this lane`);
      }
    }
  }
});

test("HSTS is at least a year and covers subdomains", async () => {
  const { rules } = await load();
  const hsts = headersFor(rules, "/").get("strict-transport-security");
  assert.match(String(hsts), /^max-age=(\d+); includeSubDomains$/);
  assert.ok(Number(String(hsts).match(/max-age=(\d+)/)?.[1]) >= 31_536_000);
});

test("the excluding matcher is anchored, so a nested embed path cannot slip past", async () => {
  const { rules } = await load();
  const cspRule = rules.find((rule) =>
    rule.headers.some((header) => header.key.toLowerCase() === "content-security-policy"));
  assert.ok(cspRule);
  assert.equal(cspRule.source, "/((?!embed/).*)");
  // A path that merely CONTAINS "embed" is still the shell and is still framed-denied.
  for (const pathname of ["/admin/embeds", "/embedded", "/x/embed/schedule"]) {
    assert.equal(headersFor(rules, pathname).get("content-security-policy"), "frame-ancestors 'none'", pathname);
  }
});
