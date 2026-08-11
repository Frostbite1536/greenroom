import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  API_CREDENTIAL_DIGEST_LENGTH,
  API_CREDENTIAL_LOOKUP_BYTES,
  API_CREDENTIAL_LOOKUP_END,
  API_CREDENTIAL_LOOKUP_LENGTH,
  API_CREDENTIAL_LOOKUP_START,
  API_CREDENTIAL_SCHEME,
  API_CREDENTIAL_SECRET_BYTES,
  API_CREDENTIAL_SECRET_LENGTH,
  API_CREDENTIAL_SEPARATOR,
  API_CREDENTIAL_TOKEN_LENGTH,
  apiCredentialDisplayPrefix,
} from "@/lib/services/api-credential-contract";

/**
 * Issuing and verifying per-event credentials for the read-only v1 API
 * (docs/ROADMAP.md, "Scoped credentials").
 *
 * The format itself, and why it is split in two, is documented in the pure
 * `lib/services/api-credential-contract` module. This module is the crypto: it
 * takes strings and returns strings, reads no environment variable, and opens
 * no database connection, so every property below is provable by unit test
 * rather than by a smoke run.
 *
 * ## Entropy
 *
 * Both halves come from `randomBytes`, Node's CSPRNG (OpenSSL `RAND_bytes`),
 * never `Math.random` and never a timestamp. The secret half is 32 bytes — 256
 * bits, the same order as the `SESSION_SECRET` minimum and far beyond the
 * `GREENROOM_API_KEY` floor of 32 characters. Rendered base64url it is 43
 * characters with no `+`, `/`, or `=` for a caller to mangle in a header.
 *
 * The lookup half is 8 bytes and is NOT a secret; it is stored in plaintext and
 * displayed in the settings list. Its randomness buys uniqueness and makes it
 * unenumerable, not confidentiality — knowing a lookup id reveals nothing and
 * authenticates nothing.
 *
 * ## Why verification is a keyed point read, not a scan and not a hashed token
 *
 * Authentication must answer "which stored credential, if any, is this?" A
 * comparison against every candidate row would be O(N) constant-time compares
 * per request — a scan. Hashing the WHOLE token and looking that digest up
 * avoids the scan, but keys a database index on material derived from the
 * secret.
 *
 * This format avoids both. The presented token is parsed positionally, the row
 * is fetched by its non-secret `lookupId` on a unique index — one point read,
 * never a scan, never a prefix match — and only then are two fixed-size SHA-256
 * digests compared with `timingSafeEqual`.
 *
 * The properties that comparison has to carry, and how it gets them:
 *
 *   - **Fixed width.** Both operands are 64-character hex digests whatever the
 *     presented secret was, so the comparison cannot leak the secret's length
 *     or how many leading characters were right.
 *   - **No secret-dependent branch.** A parse failure, an unknown lookup id, a
 *     revoked credential, a wrong secret, and a credential belonging to another
 *     event all take the same shape of path and end at the same refusal.
 *   - **No early exit.** `timingSafeEqual` compares the whole buffer; a plain
 *     `===` on digests would return on the first differing byte, which is the
 *     signal an attacker with an oracle would grind on.
 *
 * What the lookup id does leak is which credential is being tried, and that is
 * fine: it is public by design, printed in the organizer's own settings list.
 * What it never leaks is anything that helps forge the secret half.
 */

export {
  API_CREDENTIAL_SCHEME,
  API_CREDENTIAL_TOKEN_LENGTH,
  MAX_ACTIVE_API_CREDENTIALS_PER_EVENT,
  MAX_API_CREDENTIAL_LABEL_LENGTH,
  apiCredentialDisplayPrefix,
} from "@/lib/services/api-credential-contract";

/** One freshly minted credential: the plaintext to hand over, and what to store. */
export type IssuedApiCredential = {
  /**
   * The full token. This is the only time this string exists — the caller must
   * put it in exactly one response body and keep it out of storage, logs, and
   * URLs.
   */
  token: string;
  /** Non-secret, stored in plaintext, unique-indexed, displayed. */
  lookupId: string;
  /** SHA-256 hex of the secret half. The only stored form of the secret. */
  secretHash: string;
};

/** The two halves of a presented token, once it is shaped like one of ours. */
export type ParsedApiCredentialToken = {
  lookupId: string;
  secret: string;
};

const HEX = /^[0-9a-f]+$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Mint one credential. Both halves come from the CSPRNG, independently. */
export function issueApiCredential(): IssuedApiCredential {
  const lookupId = randomBytes(API_CREDENTIAL_LOOKUP_BYTES).toString("hex");
  const secret = randomBytes(API_CREDENTIAL_SECRET_BYTES).toString("base64url");
  return {
    token: `${API_CREDENTIAL_SCHEME}${lookupId}${API_CREDENTIAL_SEPARATOR}${secret}`,
    lookupId,
    secretHash: hashApiCredentialSecret(secret),
  };
}

/** The stored form of the secret half: lowercase SHA-256 hex, 64 characters. */
export function hashApiCredentialSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Split a presented token into its non-secret lookup id and its secret, or
 * return null when it is not shaped like a token this server issues.
 *
 * Positional, not `split("_")`: base64url's alphabet contains `_`, so the
 * secret half can legitimately contain the separator character and splitting
 * would put the boundary in the wrong place for a fraction of tokens. Both
 * halves have fixed lengths, so the boundary is a constant.
 *
 * Returning null is NOT an authorization decision and never shortens the
 * refusal a caller sees — a malformed token and a well-formed unknown one both
 * end at the same 401 (`lib/api/v1.ts`). It exists so that input which cannot
 * possibly match a stored row does not cost a database round trip.
 */
export function parseApiCredentialToken(token: string): ParsedApiCredentialToken | null {
  if (token.length !== API_CREDENTIAL_TOKEN_LENGTH) return null;
  if (!token.startsWith(API_CREDENTIAL_SCHEME)) return null;
  if (token.slice(API_CREDENTIAL_LOOKUP_END, API_CREDENTIAL_LOOKUP_END + 1) !== API_CREDENTIAL_SEPARATOR) {
    return null;
  }
  const lookupId = token.slice(API_CREDENTIAL_LOOKUP_START, API_CREDENTIAL_LOOKUP_END);
  const secret = token.slice(API_CREDENTIAL_LOOKUP_END + API_CREDENTIAL_SEPARATOR.length);
  if (lookupId.length !== API_CREDENTIAL_LOOKUP_LENGTH || !HEX.test(lookupId)) return null;
  if (secret.length !== API_CREDENTIAL_SECRET_LENGTH || !BASE64URL.test(secret)) return null;
  return { lookupId, secret };
}

/**
 * Constant-time equality for two SHA-256 hex digests.
 *
 * The length guard is not a shortcut around constant time: `timingSafeEqual`
 * throws outright on mismatched buffer lengths, and a value that is not 64 hex
 * characters cannot have come from `hashApiCredentialSecret`, so it is not
 * credential material and refusing it early reveals nothing about any secret.
 */
export function apiCredentialDigestsMatch(expected: string, received: string): boolean {
  if (expected.length !== API_CREDENTIAL_DIGEST_LENGTH) return false;
  if (received.length !== API_CREDENTIAL_DIGEST_LENGTH) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const receivedBytes = Buffer.from(received, "utf8");
  if (expectedBytes.length !== receivedBytes.length) return false;
  return timingSafeEqual(expectedBytes, receivedBytes);
}

/**
 * Verify a presented secret against the digest stored for the credential the
 * lookup id already selected. The single place the two halves meet.
 */
export function apiCredentialSecretMatches(storedSecretHash: string, presentedSecret: string): boolean {
  return apiCredentialDigestsMatch(storedSecretHash, hashApiCredentialSecret(presentedSecret));
}
