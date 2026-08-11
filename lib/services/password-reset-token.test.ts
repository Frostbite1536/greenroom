import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  PASSWORD_RESET_TOKEN_MAX_LENGTH,
  PASSWORD_RESET_TOKEN_TTL_MS,
  createPasswordResetToken,
  parsePasswordResetToken,
  passwordResetCredentialDigest,
  passwordResetExpiry,
  passwordResetUrl,
  verifyPasswordResetToken,
} from "./password-reset-token";

const SECRET = "greenroom-test-signing-secret-not-for-production-use";
const OTHER_SECRET = "a-completely-different-secret-of-sufficient-length!!";
const HASH = "scrypt$s1$16384$8$1$32$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhcw";
const NEW_HASH = "scrypt$s1$16384$8$1$32$bmV3c2FsdG5ld3NhbHRuZQ$bmV3aGFzaG5ld2hhc2huZXdoYXNobmV3aGFzaG5ldw";
const NOW = new Date(Date.UTC(2026, 7, 10, 12, 0, 0));

function mint(hash = HASH, now = NOW) {
  return createPasswordResetToken(
    { userId: "cuid-user-1", passwordHash: hash, expiresAt: passwordResetExpiry(now) },
    SECRET,
  );
}

function resolve(token: string, hash: string | null, now = new Date(NOW.getTime() + 1_000)): boolean {
  const parts = parsePasswordResetToken(token, now);
  return parts ? verifyPasswordResetToken(parts, hash, SECRET) : false;
}

test("a freshly minted token verifies against the hash it was signed over", () => {
  assert.equal(resolve(mint(), HASH), true);
});

test("changing the password invalidates the token by construction — no bookkeeping involved", () => {
  const token = mint();
  assert.equal(resolve(token, HASH), true, "valid before the change");
  // This is the whole design: nothing was written, nothing was revoked, no
  // `usedAt` column exists. The stored hash simply is not the one the signature
  // was derived from any more.
  assert.equal(resolve(token, NEW_HASH), false, "the same token must die with the old hash");
});

test("every token minted against the old hash dies together, not just the one that was spent", () => {
  // Two links from two /forgot requests. Spending either must retire both,
  // because both are signed over the same credential.
  const first = mint();
  const second = createPasswordResetToken(
    { userId: "cuid-user-1", passwordHash: HASH, expiresAt: passwordResetExpiry(new Date(NOW.getTime() + 60_000)) },
    SECRET,
  );
  assert.notEqual(first, second, "different expiries must produce different tokens");
  assert.equal(resolve(first, HASH), true);
  assert.equal(resolve(second, HASH), true);
  assert.equal(resolve(first, NEW_HASH), false);
  assert.equal(resolve(second, NEW_HASH), false);
});

test("an account with no credential can never be reset into", () => {
  const token = mint();
  assert.equal(resolve(token, null), false);
  assert.equal(resolve(token, ""), false);
  // And no token can be minted for one in the first place.
  assert.throws(() => createPasswordResetToken({ userId: "u", passwordHash: "", expiresAt: passwordResetExpiry(NOW) }, SECRET));
});

test("the token expires at its declared lifetime, and expiry is checked before any lookup", () => {
  const token = mint();
  const justInside = new Date(NOW.getTime() + PASSWORD_RESET_TOKEN_TTL_MS - 1_000);
  const past = new Date(NOW.getTime() + PASSWORD_RESET_TOKEN_TTL_MS + 1_000);
  assert.ok(parsePasswordResetToken(token, justInside));
  assert.equal(parsePasswordResetToken(token, past), null);
  assert.equal(resolve(token, HASH, past), false);
});

test("the lifetime is the ruled 30 minutes", () => {
  assert.equal(PASSWORD_RESET_TOKEN_TTL_MS, 30 * 60 * 1_000);
  assert.equal(passwordResetExpiry(NOW).getTime() - NOW.getTime(), PASSWORD_RESET_TOKEN_TTL_MS);
});

test("a tampered user id, expiry, or signature is refused", () => {
  const token = mint();
  const [prefix, userId, exp, signature] = token.split(".");
  assert.equal(resolve(`${prefix}.cuid-user-2.${exp}.${signature}`, HASH), false, "user id");
  assert.equal(resolve(`${prefix}.${userId}.${Number(exp) + 3600}.${signature}`, HASH), false, "expiry extension");
  assert.equal(resolve(`v2.${userId}.${exp}.${signature}`, HASH), false, "version");
  // Flip one base64url character in the signature, keeping its length legal.
  const flipped = signature.startsWith("A") ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
  assert.equal(resolve(`${prefix}.${userId}.${exp}.${flipped}`, HASH), false, "signature");
});

test("a token signed with a different secret does not verify with ours", () => {
  const foreign = createPasswordResetToken(
    { userId: "cuid-user-1", passwordHash: HASH, expiresAt: passwordResetExpiry(NOW) },
    OTHER_SECRET,
  );
  assert.equal(resolve(foreign, HASH), false);
});

test("structural parsing rejects hostile shapes before anything is hashed", () => {
  const now = new Date(NOW.getTime() + 1_000);
  for (const hostile of [
    "",
    "not-a-token",
    "v1.user.notanumber.sig",
    "v1..1900000000.sig",
    `v1.user.1900000000.${"A".repeat(42)}`,
    `v1.user.1900000000.${"A".repeat(44)}`,
    "v1.user.1900000000.sig.extra",
    "v1.user with spaces.1900000000.sig",
    "a".repeat(PASSWORD_RESET_TOKEN_MAX_LENGTH + 1),
    null,
    undefined,
    42,
    { token: "v1" },
  ]) {
    assert.equal(parsePasswordResetToken(hostile as unknown, now), null, `${String(hostile)} must not parse`);
  }
});

test("the credential digest is keyed to the secret and never equals the stored hash", () => {
  const digest = passwordResetCredentialDigest(SECRET, HASH);
  const expected = createHmac("sha256", SECRET)
    .update(`greenroom:password-reset:credential:v1\0${HASH}`)
    .digest("base64url");
  assert.equal(digest, expected, "the textual escape must preserve the NUL-delimited HMAC domain");
  assert.notEqual(digest, HASH);
  assert.ok(!HASH.includes(digest));
  assert.notEqual(digest, passwordResetCredentialDigest(OTHER_SECRET, HASH), "a different secret must derive differently");
  assert.notEqual(digest, passwordResetCredentialDigest(SECRET, NEW_HASH), "a different hash must derive differently");
  // The token itself carries the digest nowhere: it is recomputed at verify time.
  assert.ok(!mint().includes(digest));
});

test("security-sensitive source stays reviewable text without literal NUL bytes", () => {
  for (const relativePath of ["lib/services/password-reset-token.ts", "scripts/_smoke.mjs"]) {
    const source = readFileSync(join(process.cwd(), relativePath));
    assert.equal(source.includes(0), false, `${relativePath} must not be classified as a binary blob`);
  }
});

test("the reset link points at the redemption page and escapes its token", () => {
  const url = passwordResetUrl("https://greenroom-hq.test", "v1.user.1900000000.sig+with/chars=");
  assert.ok(url.startsWith("https://greenroom-hq.test/reset?token="));
  assert.ok(!url.includes("+with/chars="), "token must be percent-encoded into the query");
});
