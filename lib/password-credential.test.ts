import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_SCRYPT_PARAMETERS,
  PASSWORD_CREDENTIAL_VERSION,
  PASSWORD_MAX_LENGTH,
  formatPasswordCredential,
  hashPassword,
  parsePasswordCredential,
  verifyPassword,
  type ScryptParameters,
} from "./password-credential";

// Test-only parameters: same shape and code path, ~16x cheaper than the
// production cost so the suite stays fast.
const FAST: ScryptParameters = { cost: 1_024, blockSize: 8, parallelization: 1, keyLength: 32, saltBytes: 16 };

test("a hashed password round-trips and rejects every near miss", async () => {
  const stored = await hashPassword("correct horse battery staple", FAST);
  assert.equal(await verifyPassword("correct horse battery staple", stored), true);
  assert.equal(await verifyPassword("correct horse battery stapl", stored), false);
  assert.equal(await verifyPassword("Correct horse battery staple", stored), false);
  assert.equal(await verifyPassword("", stored), false);
  assert.equal(await verifyPassword(" correct horse battery staple", stored), false);
});

test("the stored format is versioned and self-describing", async () => {
  const stored = await hashPassword("a password", FAST);
  const [algorithm, version, cost, blockSize, parallelization, keyLength, salt, hash] = stored.split("$");
  assert.equal(algorithm, "scrypt");
  assert.equal(version, PASSWORD_CREDENTIAL_VERSION);
  assert.deepEqual(
    [cost, blockSize, parallelization, keyLength],
    [String(FAST.cost), String(FAST.blockSize), String(FAST.parallelization), String(FAST.keyLength)],
  );
  assert.match(salt, /^[A-Za-z0-9_-]+$/);
  assert.match(hash, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(salt, "base64url").length, FAST.saltBytes);
  assert.equal(Buffer.from(hash, "base64url").length, FAST.keyLength);

  // Parameters travel with the value, so a credential written at one cost still
  // verifies after the default is raised.
  const parsed = parsePasswordCredential(stored);
  assert.ok(parsed);
  assert.deepEqual(parsed.parameters, FAST);
  assert.notDeepEqual(FAST, DEFAULT_SCRYPT_PARAMETERS);
});

test("every hash gets its own salt, so identical passwords do not collide", async () => {
  const first = await hashPassword("shared-password", FAST);
  const second = await hashPassword("shared-password", FAST);
  assert.notEqual(first, second);
  assert.notEqual(first.split("$")[6], second.split("$")[6]);
  assert.equal(await verifyPassword("shared-password", first), true);
  assert.equal(await verifyPassword("shared-password", second), true);
});

test("a missing credential and a wrong password are indistinguishable to the caller", async () => {
  const stored = await hashPassword("real-password", FAST);
  const absent = await verifyPassword("real-password", null);
  const undefinedRow = await verifyPassword("real-password", undefined);
  const wrong = await verifyPassword("wrong-password", stored);
  // Same type, same value: the only signal a caller receives is `false`.
  assert.equal(absent, false);
  assert.equal(undefinedRow, false);
  assert.equal(wrong, false);
  assert.equal(typeof absent, typeof wrong);
});

test("a malformed stored credential fails closed instead of throwing", async () => {
  const good = await hashPassword("password-under-test", FAST);
  const [, , , , , , salt, hash] = good.split("$");
  const malformed = [
    "",
    " ",
    "not-a-credential",
    "scrypt",
    "$$$$$$$",
    // Wrong algorithm / version.
    good.replace(/^scrypt/, "bcrypt"),
    good.replace(`$${PASSWORD_CREDENTIAL_VERSION}$`, "$s2$"),
    // Field count.
    good.split("$").slice(0, 7).join("$"),
    `${good}$extra`,
    // Non-integer, non-canonical, or absurd parameters.
    `scrypt$${PASSWORD_CREDENTIAL_VERSION}$01024$8$1$32$${salt}$${hash}`,
    `scrypt$${PASSWORD_CREDENTIAL_VERSION}$1.5$8$1$32$${salt}$${hash}`,
    `scrypt$${PASSWORD_CREDENTIAL_VERSION}$0x400$8$1$32$${salt}$${hash}`,
    `scrypt$${PASSWORD_CREDENTIAL_VERSION}$1000$8$1$32$${salt}$${hash}`, // not a power of two
    `scrypt$${PASSWORD_CREDENTIAL_VERSION}$1073741824$8$1$32$${salt}$${hash}`, // above the cost ceiling
    `scrypt$${PASSWORD_CREDENTIAL_VERSION}$1024$1024$1$32$${salt}$${hash}`, // blockSize ceiling
    `scrypt$${PASSWORD_CREDENTIAL_VERSION}$1024$8$64$32$${salt}$${hash}`, // parallelization ceiling
    `scrypt$${PASSWORD_CREDENTIAL_VERSION}$1024$8$1$8$${salt}$${hash}`, // keyLength floor
    `scrypt$${PASSWORD_CREDENTIAL_VERSION}$1024$8$1$4096$${salt}$${hash}`, // keyLength ceiling
    // Declared key length disagrees with the stored hash.
    `scrypt$${PASSWORD_CREDENTIAL_VERSION}$1024$8$1$64$${salt}$${hash}`,
    // Truncated / re-encoded payloads.
    `scrypt$${PASSWORD_CREDENTIAL_VERSION}$1024$8$1$32$${salt}$${hash.slice(0, -2)}`,
    `scrypt$${PASSWORD_CREDENTIAL_VERSION}$1024$8$1$32$AA$${hash}`,
    `scrypt$${PASSWORD_CREDENTIAL_VERSION}$1024$8$1$32$${salt}$${hash.replace(/[-_]/g, "+")}`,
    `scrypt$${PASSWORD_CREDENTIAL_VERSION}$1024$8$1$32$${salt}$${Buffer.from(hash, "base64url").toString("base64")}`,
  ];
  for (const stored of malformed) {
    assert.equal(parsePasswordCredential(stored), null, `parse: ${JSON.stringify(stored)}`);
    assert.equal(await verifyPassword("password-under-test", stored), false, `verify: ${JSON.stringify(stored)}`);
  }
  // The unmodified value is still good, so the cases above failed on their own
  // defect rather than on a broken fixture.
  assert.ok(parsePasswordCredential(good));
  assert.equal(await verifyPassword("password-under-test", good), true);
});

test("non-string candidates and oversized passwords are refused, not coerced", async () => {
  const stored = await hashPassword("x".repeat(64), FAST);
  for (const candidate of [null, undefined, 0, 1, {}, [], true, Buffer.from("x")]) {
    assert.equal(await verifyPassword(candidate, stored), false, String(candidate));
  }
  assert.equal(await verifyPassword("x".repeat(PASSWORD_MAX_LENGTH + 1), stored), false);
  await assert.rejects(() => hashPassword("x".repeat(PASSWORD_MAX_LENGTH + 1), FAST));
  await assert.rejects(() => hashPassword("", FAST));
});

test("formatPasswordCredential and parsePasswordCredential are inverses", () => {
  const salt = Buffer.alloc(FAST.saltBytes, 0x11);
  const hash = Buffer.alloc(FAST.keyLength, 0x22);
  const stored = formatPasswordCredential(FAST, salt, hash);
  const parsed = parsePasswordCredential(stored);
  assert.ok(parsed);
  assert.deepEqual(parsed.parameters, FAST);
  assert.ok(parsed.salt.equals(salt));
  assert.ok(parsed.hash.equals(hash));
  assert.equal(formatPasswordCredential(parsed.parameters, parsed.salt, parsed.hash), stored);
});

test("the production default is a real work factor, not a placeholder", () => {
  assert.ok(DEFAULT_SCRYPT_PARAMETERS.cost >= 16_384);
  assert.equal(DEFAULT_SCRYPT_PARAMETERS.cost & (DEFAULT_SCRYPT_PARAMETERS.cost - 1), 0);
  assert.ok(DEFAULT_SCRYPT_PARAMETERS.saltBytes >= 16);
  assert.ok(DEFAULT_SCRYPT_PARAMETERS.keyLength >= 32);
});

test("the credential module never logs and never returns the plaintext", () => {
  const source = readFileSync(new URL("./password-credential.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /console\./);
  // The scrypt callback must not forward node's error object, which can carry
  // the arguments it was called with.
  assert.match(source, /reject\(new Error\("scrypt derivation failed"\)\)/);
});
