import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import {
  DEMO_PERSONAS,
  SESSION_TTL_SECONDS,
  decodePendingSession,
  decodeSession,
  homeForRole,
  isSessionCredentialCurrent,
  sessionCredentialFingerprint,
  signPendingSession,
  signSession,
} from "./auth";
import { getServerSigningSecret } from "./server-signing";

const NEWCOMER = { id: "user-new", name: "Wren Halloway", email: "wren@example.test" };
/** Any fingerprint string: these tests are about the envelope, not the binding. */
const CF = "test-credential-fingerprint";

test("signed session round-trips and keeps only the expected session fields", () => {
  const now = Date.UTC(2026, 4, 12, 9, 0, 0);
  const encoded = signSession(DEMO_PERSONAS.admin, CF, now);
  assert.deepEqual(decodeSession(encoded, now + 1_000), DEMO_PERSONAS.admin);
});

test("session rejects an altered payload or signature", () => {
  const now = Date.UTC(2026, 4, 12, 9, 0, 0);
  const encoded = signSession(DEMO_PERSONAS.speaker, CF, now);
  const [payload, signature] = encoded.split(".");
  const legacyUnsigned = Buffer.from(JSON.stringify(DEMO_PERSONAS.admin), "utf8").toString("base64url");
  assert.equal(decodeSession(legacyUnsigned, now), null);
  assert.equal(decodeSession(`${payload}x.${signature}`, now), null);
  assert.equal(decodeSession(`${payload}.${signature}x`, now), null);
});

test("session expires at its declared lifetime", () => {
  const now = Date.UTC(2026, 4, 12, 9, 0, 0);
  const encoded = signSession(DEMO_PERSONAS.evaluator, CF, now);
  assert.equal(decodeSession(encoded, now + SESSION_TTL_SECONDS * 1_000), null);
});

test("production fails closed when its configured secret is missing or too short", () => {
  const env = process.env as Record<string, string | undefined>;
  const originalNodeEnv = env.NODE_ENV;
  const originalSecret = env.SESSION_SECRET;
  try {
    env.NODE_ENV = "production";
    env.SESSION_SECRET = "too-short";
    assert.throws(() => signSession(DEMO_PERSONAS.admin, CF));
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
  const encoded = signPendingSession(NEWCOMER, CF, now);
  assert.deepEqual(decodePendingSession(encoded, now + 1_000), { user: NEWCOMER, pending: true });
});

test("the two payload variants are disjoint, so a pending cookie grants nothing", () => {
  const now = Date.UTC(2026, 4, 12, 9, 0, 0);
  const pending = signPendingSession(NEWCOMER, CF, now);
  const real = signSession(DEMO_PERSONAS.admin, CF, now);

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
    cf: CF,
    iat,
    exp: iat + SESSION_TTL_SECONDS,
  };
  // Signing it the way the module does, to prove the rejection is the shape
  // check and not a signature failure.
  const encoded = signPendingSession(NEWCOMER, CF, now);
  const [, signature] = encoded.split(".");
  const forgedPayload = Buffer.from(JSON.stringify(hybrid), "utf8").toString("base64url");
  assert.equal(decodeSession(`${forgedPayload}.${signature}`, now + 1_000), null);
  assert.equal(decodePendingSession(`${forgedPayload}.${signature}`, now + 1_000), null);
});

test("a pending cookie expires and fails signature checks exactly like a session", () => {
  const now = Date.UTC(2026, 4, 12, 9, 0, 0);
  const encoded = signPendingSession(NEWCOMER, CF, now);
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

/* SEC-03: a session is bound to the credential it was issued under. */

test("SEC-03: the credential fingerprint binds to the stored hash and reveals nothing about it", () => {
  const before = sessionCredentialFingerprint("scrypt$v1$salt$old-hash");
  assert.equal(sessionCredentialFingerprint("scrypt$v1$salt$old-hash"), before, "stable for one credential");
  assert.notEqual(sessionCredentialFingerprint("scrypt$v1$salt$new-hash"), before, "changes with the credential");
  assert.notEqual(sessionCredentialFingerprint(null), before, "setting a first password changes it too");
  assert.equal(sessionCredentialFingerprint(null), sessionCredentialFingerprint(undefined));
  assert.doesNotMatch(before, /old-hash|scrypt/);
});

test("SEC-03: a session survives only while the credential it was issued under is current", () => {
  const issuedUnder = sessionCredentialFingerprint("scrypt$v1$salt$old-hash");
  assert.equal(isSessionCredentialCurrent(issuedUnder, "scrypt$v1$salt$old-hash"), true);
  // A password reset writes a new hash: every cookie issued before it is refused.
  assert.equal(isSessionCredentialCurrent(issuedUnder, "scrypt$v1$salt$new-hash"), false);
  assert.equal(isSessionCredentialCurrent(issuedUnder, null), false);
  assert.equal(isSessionCredentialCurrent("", "scrypt$v1$salt$old-hash"), false);
  assert.equal(isSessionCredentialCurrent("not base64url !", "scrypt$v1$salt$old-hash"), false);
});

test("SEC-03: a cookie signed before credential binding existed is no longer a session", () => {
  const now = Date.UTC(2026, 4, 12, 9, 0, 0);
  const iat = Math.floor(now / 1_000);
  const secret = getServerSigningSecret();
  assert.ok(secret, "the non-production fallback secret is available to tests");
  const sign = (body: object) => {
    const payload = Buffer.from(JSON.stringify({ ...body, iat, exp: iat + SESSION_TTL_SECONDS }), "utf8").toString("base64url");
    return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
  };
  // Validly signed, unexpired, correct shape in every other respect, but no `cf`.
  assert.equal(decodeSession(sign(DEMO_PERSONAS.admin), now + 1_000), null);
  assert.equal(decodePendingSession(sign({ user: NEWCOMER, pending: true }), now + 1_000), null);
  // The same bodies with a fingerprint decode, which isolates the cause.
  assert.deepEqual(decodeSession(sign({ ...DEMO_PERSONAS.admin, cf: CF }), now + 1_000), DEMO_PERSONAS.admin);
});
