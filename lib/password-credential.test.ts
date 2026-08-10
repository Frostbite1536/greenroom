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
  // Deterministic payloads: a case built by mutating the random hash could
  // silently become a *valid* credential when that hash happens to contain no
  // character the mutation touches.
  const zeros = Buffer.alloc(FAST.keyLength, 0).toString("base64url");
  // Same 32 bytes, but with a padding bit set in the final sextet — one
  // credential must have exactly one representation.
  const nonCanonicalHash = `${zeros.slice(0, -1)}B`;
  const zeroSalt = Buffer.alloc(FAST.saltBytes, 0).toString("base64url");
  const nonCanonicalSalt = `${zeroSalt.slice(0, -1)}B`;
  // Standard base64 alphabet (`+`, `/`, `=`) is not base64url.
  const standardAlphabetHash = Buffer.alloc(FAST.keyLength, 0xfb).toString("base64");
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
    `scrypt$${PASSWORD_CREDENTIAL_VERSION}$1024$8$1$32$AA$${hash}`, // salt below the floor
    `scrypt$${PASSWORD_CREDENTIAL_VERSION}$1024$8$1$32$${salt}$${nonCanonicalHash}`,
    `scrypt$${PASSWORD_CREDENTIAL_VERSION}$1024$8$1$32$${salt}$${standardAlphabetHash}`,
    `scrypt$${PASSWORD_CREDENTIAL_VERSION}$1024$8$1$32$${nonCanonicalSalt}$${hash}`,
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

test("the credential module logs a bounded label only, never the plaintext", () => {
  const source = readFileSync(new URL("./password-credential.ts", import.meta.url), "utf8");
  // The scrypt callback must not forward node's error object, which can carry
  // the arguments it was called with.
  assert.match(source, /reject\(new Error\("scrypt derivation failed"\)\)/);

  // One diagnostic, and it carries a fixed label plus `diagnosticLabel` only —
  // no password, no salt, no stored value, and never an exception message.
  const logs = source.match(/console\.\w+\([^\r\n]*/g) ?? [];
  assert.deepEqual(logs, ['console.warn("[password-credential] derivation failed", diagnosticLabel(error));']);
  for (const line of logs) {
    // Check the ARGUMENTS, not the whole line: the fixed label legitimately
    // contains the word "password" (it names the module), and a naive substring
    // scan over the label would be a test that only looks strict.
    const args = line.slice(line.indexOf('",') + 2, line.lastIndexOf(")"));
    assert.equal(args.trim(), "diagnosticLabel(error)");
    for (const forbidden of ["password", "candidate", "stored", "parsed", "salt", "derived", ".message", "${"]) {
      assert.ok(!args.includes(forbidden), `diagnostic must not carry ${forbidden}: ${args}`);
    }
  }
});

test("the parameter fields reject anything that is not a bounded positive integer", () => {
  const salt = Buffer.alloc(16, 1).toString("base64url");
  const hash = Buffer.alloc(32, 2).toString("base64url");
  const withCost = (cost: string) => `scrypt$s1$${cost}$8$1$32$${salt}$${hash}`;
  // Explicitly including the values that would reach scrypt as a non-finite or
  // unsafe allocation request if the guard were ever loosened.
  for (const cost of ["Infinity", "-Infinity", "NaN", "1e5", "0", "-1024", "1_024", "99999999999", "١٠٢٤"]) {
    assert.equal(parsePasswordCredential(withCost(cost)), null, cost);
  }
  assert.ok(parsePasswordCredential(withCost("1024")));
});
