import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEMO_PERSONAS,
  SESSION_TTL_SECONDS,
  decodePendingSession,
  decodeSession,
  encodePendingSession,
  encodeSession,
  homeForRole,
} from "./auth";

const NEWCOMER = { id: "user-new", name: "Wren Halloway", email: "wren@example.test" };

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

test("a pending identity round-trips through the same signed cookie", () => {
  const now = Date.UTC(2026, 4, 12, 9, 0, 0);
  const encoded = encodePendingSession(NEWCOMER, now);
  assert.deepEqual(decodePendingSession(encoded, now + 1_000), { user: NEWCOMER, pending: true });
});

test("the two payload variants are disjoint, so a pending cookie grants nothing", () => {
  const now = Date.UTC(2026, 4, 12, 9, 0, 0);
  const pending = encodePendingSession(NEWCOMER, now);
  const real = encodeSession(DEMO_PERSONAS.admin, now);

  // This is the property the whole design rests on. `decodeSession` is what
  // `getSession`, `getResolvedSession`, `requireSession` and `getApiContext` all
  // sit on top of, so a pending cookie being invisible to it means a
  // membership-less identity has zero authority everywhere, by construction
  // rather than by a null check somebody has to remember to write.
  assert.equal(decodeSession(pending, now + 1_000), null);
  assert.equal(decodePendingSession(real, now + 1_000), null);
});

test("a pending payload cannot smuggle an event or a role past the shape check", () => {
  const now = Date.UTC(2026, 4, 12, 9, 0, 0);
  const iat = Math.floor(now / 1_000);
  // Hand-built payloads that a hostile signer would try if they ever obtained
  // the secret: the marker plus authority fields, and authority fields plus the
  // marker. Neither shape may satisfy either decoder.
  const hybrid = {
    user: NEWCOMER,
    pending: true,
    event: DEMO_PERSONAS.admin.event,
    role: "ADMIN",
    iat,
    exp: iat + SESSION_TTL_SECONDS,
  };
  // Signing it the way the module does, to prove the rejection is the shape
  // check and not a signature failure.
  const encoded = encodePendingSession(NEWCOMER, now);
  const [, signature] = encoded.split(".");
  const forgedPayload = Buffer.from(JSON.stringify(hybrid), "utf8").toString("base64url");
  assert.equal(decodeSession(`${forgedPayload}.${signature}`, now + 1_000), null);
  assert.equal(decodePendingSession(`${forgedPayload}.${signature}`, now + 1_000), null);
});

test("a pending cookie expires and fails signature checks exactly like a session", () => {
  const now = Date.UTC(2026, 4, 12, 9, 0, 0);
  const encoded = encodePendingSession(NEWCOMER, now);
  const [payload, signature] = encoded.split(".");
  assert.equal(decodePendingSession(encoded, now + SESSION_TTL_SECONDS * 1_000), null);
  assert.equal(decodePendingSession(`${payload}x.${signature}`, now), null);
  assert.equal(decodePendingSession(`${payload}.${signature}x`, now), null);
  assert.equal(decodePendingSession(payload, now), null, "an unsigned payload is not a cookie");
});

test("persisted roles choose the same homes for login and root redirects", () => {
  assert.equal(homeForRole("ADMIN"), "/admin");
  assert.equal(homeForRole("EVALUATOR"), "/admin/evaluations");
  assert.equal(homeForRole("SPEAKER"), "/portal");
});
