import assert from "node:assert/strict";
import { test } from "node:test";
import { DEMO_PERSONAS, SESSION_TTL_SECONDS, decodeSession, encodeSession, homeForRole } from "./auth";

test("signed session round-trips and keeps only the expected session fields", () => {
  const now = Date.UTC(2026, 4, 12, 9, 0, 0);
  const encoded = encodeSession(DEMO_PERSONAS.admin, now);
  assert.deepEqual(decodeSession(encoded, now + 1_000), DEMO_PERSONAS.admin);
});

test("session rejects an altered payload or signature", () => {
  const now = Date.UTC(2026, 4, 12, 9, 0, 0);
  const encoded = encodeSession(DEMO_PERSONAS.speaker, now);
  const [payload, signature] = encoded.split(".");
  const legacyUnsigned = Buffer.from(JSON.stringify(DEMO_PERSONAS.admin), "utf8").toString("base64url");
  assert.equal(decodeSession(legacyUnsigned, now), null);
  assert.equal(decodeSession(`${payload}x.${signature}`, now), null);
  assert.equal(decodeSession(`${payload}.${signature}x`, now), null);
});

test("session expires at its declared lifetime", () => {
  const now = Date.UTC(2026, 4, 12, 9, 0, 0);
  const encoded = encodeSession(DEMO_PERSONAS.evaluator, now);
  assert.equal(decodeSession(encoded, now + SESSION_TTL_SECONDS * 1_000), null);
});

test("production fails closed when its configured secret is missing or too short", () => {
  const env = process.env as Record<string, string | undefined>;
  const originalNodeEnv = env.NODE_ENV;
  const originalSecret = env.SESSION_SECRET;
  try {
    env.NODE_ENV = "production";
    env.SESSION_SECRET = "too-short";
    assert.throws(() => encodeSession(DEMO_PERSONAS.admin));
    assert.equal(decodeSession("not-a-signed-session"), null);
  } finally {
    if (originalNodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = originalNodeEnv;
    if (originalSecret === undefined) delete env.SESSION_SECRET;
    else env.SESSION_SECRET = originalSecret;
  }
});

test("persisted roles choose the same homes for login and root redirects", () => {
  assert.equal(homeForRole("ADMIN"), "/admin");
  assert.equal(homeForRole("EVALUATOR"), "/admin/evaluations");
  assert.equal(homeForRole("SPEAKER"), "/portal");
});
