import assert from "node:assert/strict";
import test from "node:test";
import {
  DRAFT_CAPABILITY_BYTES,
  DRAFT_CAPABILITY_PATTERN,
  generateDraftCapability,
  hashDraftCapability,
  matchesDraftCapability,
  verifyDraftWriteAccess,
} from "./draft-capability";

const secret = "scratch-signing-secret-at-least-32-characters";

test("draft capabilities are exactly 256-bit base64url values", () => {
  const capability = generateDraftCapability(() => Buffer.alloc(DRAFT_CAPABILITY_BYTES, 0xab));
  assert.match(capability, DRAFT_CAPABILITY_PATTERN);
  assert.equal(capability.length, 43);
});

test("draft capability HMACs are domain-separated and persist no raw capability", () => {
  const capability = generateDraftCapability(() => Buffer.alloc(DRAFT_CAPABILITY_BYTES, 0x11));
  const hash = hashDraftCapability(capability, secret);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(hash, new RegExp(capability.slice(0, 8), "i"));
  assert.notEqual(hash, hashDraftCapability(capability, `${secret}-rotated`));
});

test("draft capability comparison accepts only the matching stored HMAC", () => {
  const capability = generateDraftCapability(() => Buffer.alloc(DRAFT_CAPABILITY_BYTES, 0x22));
  const hash = hashDraftCapability(capability, secret);
  assert.equal(matchesDraftCapability(hash, capability, secret), true);
  assert.equal(matchesDraftCapability(hash, generateDraftCapability(() => Buffer.alloc(DRAFT_CAPABILITY_BYTES, 0x23)), secret), false);
  assert.equal(matchesDraftCapability(null, capability, secret), false);
  assert.equal(matchesDraftCapability(hash, "", secret), false);
  assert.equal(matchesDraftCapability(hash, "x".repeat(129), secret), false);
  assert.equal(matchesDraftCapability(hash, { capability }, secret), false);
});

test("only a valid capability may reveal a stale draft revision", () => {
  const capability = generateDraftCapability(() => Buffer.alloc(DRAFT_CAPABILITY_BYTES, 0x24));
  const storedHash = hashDraftCapability(capability, secret);
  const base = { storedHash, secret, draftRevision: 1 };
  assert.equal(verifyDraftWriteAccess({ ...base, capability: "", expectedDraftRevision: 0 }), "not_found");
  assert.equal(verifyDraftWriteAccess({ ...base, capability: "x".repeat(129), expectedDraftRevision: 0 }), "not_found");
  assert.equal(verifyDraftWriteAccess({ ...base, capability: { capability }, expectedDraftRevision: 0 }), "not_found");
  assert.equal(verifyDraftWriteAccess({ ...base, capability, expectedDraftRevision: undefined }), "not_found");
  assert.equal(verifyDraftWriteAccess({ ...base, capability, expectedDraftRevision: 0 }), "conflict");
  assert.equal(verifyDraftWriteAccess({ ...base, capability, expectedDraftRevision: 1 }), "ok");
});
