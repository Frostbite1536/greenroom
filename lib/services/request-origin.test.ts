import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyRequestOrigin,
  expectedRequestOrigins,
  isSameOriginRequest,
  normalizeOrigin,
} from "./request-origin";

const SITE = "https://greenroom.example";
const expected = [SITE];

test("a cross-origin post is refused, and a same-origin post is accepted", () => {
  assert.equal(classifyRequestOrigin({ origin: SITE, expected }), "same-origin");
  assert.equal(classifyRequestOrigin({ origin: "https://attacker.example", expected }), "cross-origin");
  // The classic near-miss set: a suffix, a prefix, a different scheme, a
  // different port, and a subdomain are all separate origins.
  for (const hostile of [
    "https://greenroom.example.attacker.test",
    "https://attacker.test/greenroom.example",
    "http://greenroom.example",
    "https://greenroom.example:8443",
    "https://evil.greenroom.example",
  ]) {
    assert.equal(classifyRequestOrigin({ origin: hostile, expected }), "cross-origin", hostile);
  }
});

test("an opaque or unparseable Origin is cross-origin, never 'missing'", () => {
  // A sandboxed iframe or a `data:` document serializes its origin as "null".
  // Treating that as absent would hand it the missing-header policy.
  for (const opaque of ["null", "  null  ", "not a url", "://", "file:///etc/passwd", "javascript:alert(1)"]) {
    assert.equal(classifyRequestOrigin({ origin: opaque, expected }), "cross-origin", opaque);
  }
});

test("Referer is the documented fallback, and only when Origin is absent", () => {
  assert.equal(classifyRequestOrigin({ referer: `${SITE}/login`, expected }), "same-origin");
  assert.equal(classifyRequestOrigin({ referer: "https://attacker.example/x", expected }), "cross-origin");
  // A hostile Origin is never rescued by a friendly Referer.
  assert.equal(
    classifyRequestOrigin({ origin: "https://attacker.example", referer: `${SITE}/login`, expected }),
    "cross-origin",
  );
});

test("both headers absent is 'missing', and missing is not same-origin", () => {
  assert.equal(classifyRequestOrigin({ expected }), "missing");
  assert.equal(classifyRequestOrigin({ origin: null, referer: undefined, expected }), "missing");
  assert.equal(classifyRequestOrigin({ origin: "   ", referer: "", expected }), "missing");
  // The pinned policy: only a positive same-origin verdict may proceed, so
  // missing and cross-origin are both refused.
  assert.equal(isSameOriginRequest("same-origin"), true);
  assert.equal(isSameOriginRequest("cross-origin"), false);
  assert.equal(isSameOriginRequest("missing"), false);
});

test("an empty expected set can never accept anything", () => {
  assert.equal(classifyRequestOrigin({ origin: SITE, expected: [] }), "cross-origin");
  assert.equal(classifyRequestOrigin({ referer: `${SITE}/login`, expected: [] }), "cross-origin");
});

test("the expected origins come from the host the browser actually addressed", () => {
  assert.deepEqual(
    expectedRequestOrigins({
      requestUrl: "http://10.0.0.4:3000/api/auth/login",
      host: "10.0.0.4:3000",
      forwardedHost: "greenroom.example",
      forwardedProto: "https",
    }),
    // The proxy's public origin first, then the internal address the handler
    // actually saw — both are origins a browser could legitimately have
    // addressed, and neither is settable by an attacking page.
    ["https://greenroom.example", "https://10.0.0.4:3000", "http://10.0.0.4:3000"],
  );
  // A configured APP_URL is additive, not a replacement: a deployment reachable
  // under more than one hostname keeps working.
  assert.deepEqual(
    expectedRequestOrigins({
      requestUrl: "http://127.0.0.1:3219/api/auth/login",
      host: "127.0.0.1:3219",
      appUrl: "https://greenroom-hq.test/somewhere",
    }),
    ["https://127.0.0.1:3219", "http://127.0.0.1:3219", "https://greenroom-hq.test"],
  );
});

test("proxy headers are taken one value deep and rejected when malformed", () => {
  assert.deepEqual(
    expectedRequestOrigins({
      requestUrl: "https://greenroom.example/api/auth/login",
      forwardedHost: "greenroom.example, attacker.example",
      forwardedProto: "https, http",
    }),
    ["https://greenroom.example"],
  );
  // Whitespace or a path separator smuggled into a host header yields nothing
  // rather than a forged origin.
  assert.deepEqual(
    expectedRequestOrigins({
      requestUrl: "https://greenroom.example/api/auth/login",
      host: "greenroom.example/../attacker.example",
      forwardedHost: "green room.example",
    }),
    ["https://greenroom.example"],
  );
});

test("without a proto signal both schemes on the addressed host are accepted", () => {
  const origins = expectedRequestOrigins({
    requestUrl: "http://127.0.0.1:3219/api/auth/login",
    host: "127.0.0.1:3219",
  });
  // `next start` serves http locally while a deployment terminates TLS
  // upstream; the host is the part a page cannot forge, so the scheme alone
  // must not refuse a legitimate post.
  assert.ok(origins.includes("http://127.0.0.1:3219"));
  assert.ok(origins.includes("https://127.0.0.1:3219"));
  assert.ok(!origins.some((origin) => origin.includes("attacker")));
});

test("normalizeOrigin canonicalizes and refuses anything that is not http(s)", () => {
  assert.equal(normalizeOrigin("https://greenroom.example/login?next=1#x"), "https://greenroom.example");
  assert.equal(normalizeOrigin("https://greenroom.example:443"), "https://greenroom.example");
  assert.equal(normalizeOrigin("http://greenroom.example:80"), "http://greenroom.example");
  assert.equal(normalizeOrigin("HTTPS://GreenRoom.Example"), "https://greenroom.example");
  for (const bad of [null, undefined, "", "   ", "null", "ftp://greenroom.example", "data:text/html,x", "/login"]) {
    assert.equal(normalizeOrigin(bad), null, String(bad));
  }
});
