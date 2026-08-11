/**
 * The shape and bounds of a per-event API credential, and nothing else.
 *
 * This module is deliberately PURE: it imports nothing — not `node:crypto`, not
 * Prisma, not the environment. That is what lets the browser-side settings
 * panel state the same label bound the server enforces without dragging a Node
 * builtin into the client bundle, exactly as `lib/api/v1-contract.ts` does for
 * the published contract document.
 *
 * ## The token format
 *
 *     grk_<lookupId>_<secret>
 *     └┬─┘ └───┬───┘ └──┬───┘
 *      │       │        └─ 32 CSPRNG bytes, base64url: the actual secret.
 *      │       │           Stored ONLY as a SHA-256 digest.
 *      │       └────────── 8 CSPRNG bytes, lowercase hex: a NON-SECRET
 *      │                   identifier, stored in plaintext under a unique
 *      │                   index. It is what authentication looks the row up
 *      │                   by, and it is what the settings list displays.
 *      └────────────────── fixed scheme marker, so a leaked token is
 *                          recognisable to a secret scanner.
 *
 * Splitting the credential in two is the point. Authentication is a single
 * indexed point read on a value that is not secret, followed by one fixed-size
 * constant-time digest comparison. Nothing ever scans, iterates, or
 * prefix-matches an event's keys, and no index in the database is keyed on
 * material derived from the secret.
 *
 * The lengths are fixed, which is what makes parsing positional rather than a
 * split on `_`. That matters: base64url's alphabet CONTAINS `_`, so the secret
 * half can legitimately hold separators and `token.split("_")` would be
 * ambiguous. The lookup id is hex for the same reason — it can never contain
 * the separator that follows it.
 */

/** Marks an issued credential as a Greenroom key to a human and to a scanner. */
export const API_CREDENTIAL_SCHEME = "grk_";

/** Separator between the non-secret lookup id and the secret. */
export const API_CREDENTIAL_SEPARATOR = "_";

/** CSPRNG bytes behind the non-secret lookup id, rendered as lowercase hex. */
export const API_CREDENTIAL_LOOKUP_BYTES = 8;

/** CSPRNG bytes behind the secret half: 256 bits, rendered base64url. */
export const API_CREDENTIAL_SECRET_BYTES = 32;

/** Hex is two characters per byte. */
export const API_CREDENTIAL_LOOKUP_LENGTH = API_CREDENTIAL_LOOKUP_BYTES * 2;

/** Unpadded base64url is ceil(bytes * 4 / 3) characters. */
export const API_CREDENTIAL_SECRET_LENGTH = Math.ceil((API_CREDENTIAL_SECRET_BYTES * 4) / 3);

/** Every issued token is exactly this long. */
export const API_CREDENTIAL_TOKEN_LENGTH =
  API_CREDENTIAL_SCHEME.length +
  API_CREDENTIAL_LOOKUP_LENGTH +
  API_CREDENTIAL_SEPARATOR.length +
  API_CREDENTIAL_SECRET_LENGTH;

/** Where the lookup id starts and ends inside an issued token. */
export const API_CREDENTIAL_LOOKUP_START = API_CREDENTIAL_SCHEME.length;
export const API_CREDENTIAL_LOOKUP_END = API_CREDENTIAL_LOOKUP_START + API_CREDENTIAL_LOOKUP_LENGTH;

/** SHA-256 rendered as lowercase hex. */
export const API_CREDENTIAL_DIGEST_LENGTH = 64;

/** Longest accepted operator-supplied label. */
export const MAX_API_CREDENTIAL_LABEL_LENGTH = 80;

/**
 * Active credentials one event may hold at once. A bound exists so a
 * compromised or scripted admin session cannot quietly mint an unbounded set of
 * long-lived keys; ten is well past what an organizer's integrations need, and
 * revoking one frees a slot immediately.
 */
export const MAX_ACTIVE_API_CREDENTIALS_PER_EVENT = 10;

/**
 * How a credential is shown in a list: the whole non-secret half of the token.
 *
 * Derived, never stored. A stored copy of a value that is a pure function of
 * `lookupId` would be a second source of truth with nothing keeping the two in
 * step.
 */
export function apiCredentialDisplayPrefix(lookupId: string): string {
  return `${API_CREDENTIAL_SCHEME}${lookupId}`;
}
