import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const DRAFT_CAPABILITY_BYTES = 32;
export const DRAFT_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Generate a 256-bit opaque browser capability; only its HMAC is persisted. */
export function generateDraftCapability(
  randomBytesFn: (size: number) => Buffer = randomBytes,
): string {
  return randomBytesFn(DRAFT_CAPABILITY_BYTES).toString("base64url");
}

/** Domain-separated HMAC so draft capabilities cannot collide with other proofs. */
export function hashDraftCapability(capability: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`greenroom:cfp-draft-capability:v1:${capability}`)
    .digest("hex");
}

/** Constant-time comparison for a stored HMAC and an untrusted raw capability. */
export function matchesDraftCapability(
  storedHash: string | null | undefined,
  capability: unknown,
  secret: string,
): boolean {
  if (
    !storedHash ||
    typeof capability !== "string" ||
    !DRAFT_CAPABILITY_PATTERN.test(capability) ||
    !/^[a-f0-9]{64}$/.test(storedHash)
  ) {
    return false;
  }
  const expected = Buffer.from(hashDraftCapability(capability, secret), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return stored.length === expected.length && timingSafeEqual(stored, expected);
}

export type DraftWriteAccess = "ok" | "not_found" | "conflict";

/**
 * Keep anonymous draft failures opaque: only a valid capability is allowed to
 * distinguish an old revision from a missing/wrong/revoked capability.
 */
export function verifyDraftWriteAccess(input: {
  storedHash: string | null | undefined;
  capability: unknown;
  secret: string;
  draftRevision: number;
  expectedDraftRevision: number | undefined;
}): DraftWriteAccess {
  if (
    input.expectedDraftRevision === undefined ||
    !matchesDraftCapability(input.storedHash, input.capability, input.secret)
  ) {
    return "not_found";
  }
  return input.draftRevision === input.expectedDraftRevision ? "ok" : "conflict";
}
