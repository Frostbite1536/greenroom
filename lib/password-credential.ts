import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Password credentials for provisioned users (D-C5-6).
 *
 * Pure `node:crypto` scrypt — no new dependency. Every stored credential is a
 * single self-describing string so the work factor can be raised later without
 * a migration: an old row still verifies with the parameters it was written
 * with, and a re-hash simply writes a newer parameter set.
 *
 *   scrypt$s1$<N>$<r>$<p>$<keyLength>$<saltBase64Url>$<hashBase64Url>
 *
 * Rules this module exists to keep in one place:
 * - Every user gets an independent random salt, so two users who chose the same
 *   password do not share a stored value.
 * - Comparison is `timingSafeEqual` over equal-length buffers.
 * - Anything unparseable **fails closed** and still burns comparable CPU, so a
 *   caller cannot learn from latency whether a row existed or was well-formed.
 * - Nothing here logs, throws with, or otherwise reveals the plaintext.
 */

export const PASSWORD_CREDENTIAL_ALGORITHM = "scrypt";
/** Bump only when the field layout changes; parameters live in the string. */
export const PASSWORD_CREDENTIAL_VERSION = "s1";

export type ScryptParameters = {
  /** CPU/memory cost. Must be a power of two greater than 1. */
  cost: number;
  blockSize: number;
  parallelization: number;
  keyLength: number;
  saltBytes: number;
};

export const DEFAULT_SCRYPT_PARAMETERS: ScryptParameters = {
  cost: 16_384,
  blockSize: 8,
  parallelization: 1,
  keyLength: 32,
  saltBytes: 16,
};

/**
 * Bounds a hostile or corrupted stored string cannot cross. `cost * blockSize`
 * caps the memory one verification may request; the rest keep a malformed row
 * from turning a login attempt into a denial of service.
 */
const LIMITS = {
  maxCost: 1 << 20,
  maxBlockSize: 32,
  maxParallelization: 4,
  minKeyLength: 16,
  maxKeyLength: 64,
  minSaltBytes: 8,
  maxSaltBytes: 64,
  maxCostTimesBlockSize: 1 << 21,
} as const;

/** scrypt needs `128 * cost * blockSize` bytes; give it headroom, not a cliff. */
const SCRYPT_MAX_MEMORY = 256 * 1024 * 1024;

/** Passwords are bounded at the boundary: scrypt cost does not depend on length. */
export const PASSWORD_MAX_LENGTH = 512;

export type ParsedPasswordCredential = {
  parameters: ScryptParameters;
  salt: Buffer;
  hash: Buffer;
};

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 1 && (value & (value - 1)) === 0;
}

/** Strict positive integer field — rejects "", "+1", "1.0", "0x10", " 1". */
function parseIntegerField(raw: string): number | null {
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) return null;
  return Number(raw);
}

/** Base64url with no padding, decoding to exactly `expectedBytes`. */
function decodeExact(raw: string, expectedBytes: number): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const decoded = Buffer.from(raw, "base64url");
  if (decoded.length !== expectedBytes) return null;
  // Reject non-canonical encodings (trailing bits set) so one credential has
  // exactly one representation.
  if (decoded.toString("base64url") !== raw) return null;
  return decoded;
}

export function formatPasswordCredential(
  parameters: ScryptParameters,
  salt: Buffer,
  hash: Buffer,
): string {
  return [
    PASSWORD_CREDENTIAL_ALGORITHM,
    PASSWORD_CREDENTIAL_VERSION,
    parameters.cost,
    parameters.blockSize,
    parameters.parallelization,
    parameters.keyLength,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

/**
 * Parse a stored credential. Returns null for anything that is not exactly the
 * expected shape — unknown algorithm or version, out-of-range parameters, a
 * non-power-of-two cost, a salt or hash whose decoded length disagrees with the
 * declared parameters. Callers must treat null as "no usable credential".
 */
export function parsePasswordCredential(stored: string | null | undefined): ParsedPasswordCredential | null {
  if (typeof stored !== "string") return null;
  const parts = stored.split("$");
  if (parts.length !== 8) return null;
  const [algorithm, version, costRaw, blockSizeRaw, parallelRaw, keyLengthRaw, saltRaw, hashRaw] = parts;
  if (algorithm !== PASSWORD_CREDENTIAL_ALGORITHM) return null;
  if (version !== PASSWORD_CREDENTIAL_VERSION) return null;

  const cost = parseIntegerField(costRaw);
  const blockSize = parseIntegerField(blockSizeRaw);
  const parallelization = parseIntegerField(parallelRaw);
  const keyLength = parseIntegerField(keyLengthRaw);
  if (cost === null || blockSize === null || parallelization === null || keyLength === null) return null;
  if (!isPowerOfTwo(cost) || cost > LIMITS.maxCost) return null;
  if (blockSize > LIMITS.maxBlockSize) return null;
  if (parallelization > LIMITS.maxParallelization) return null;
  if (keyLength < LIMITS.minKeyLength || keyLength > LIMITS.maxKeyLength) return null;
  if (cost * blockSize > LIMITS.maxCostTimesBlockSize) return null;

  const hash = decodeExact(hashRaw, keyLength);
  if (!hash) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(saltRaw)) return null;
  const salt = Buffer.from(saltRaw, "base64url");
  if (salt.length < LIMITS.minSaltBytes || salt.length > LIMITS.maxSaltBytes) return null;
  if (salt.toString("base64url") !== saltRaw) return null;

  return {
    parameters: { cost, blockSize, parallelization, keyLength, saltBytes: salt.length },
    salt,
    hash,
  };
}

function derive(password: string, salt: Buffer, parameters: ScryptParameters): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(password, "utf8"),
      salt,
      parameters.keyLength,
      {
        N: parameters.cost,
        r: parameters.blockSize,
        p: parameters.parallelization,
        maxmem: SCRYPT_MAX_MEMORY,
      },
      // Never attach the plaintext to the rejection: this error is logged by
      // callers that must never see a password.
      (error, derivedKey) => (error ? reject(new Error("scrypt derivation failed")) : resolve(derivedKey)),
    );
  });
}

/** Hash a password with a fresh random salt. Used by the seed and provisioning only. */
export async function hashPassword(
  password: string,
  parameters: ScryptParameters = DEFAULT_SCRYPT_PARAMETERS,
): Promise<string> {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("A password is required.");
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new Error("Password exceeds the supported length.");
  }
  const salt = randomBytes(parameters.saltBytes);
  const hash = await derive(password, salt, parameters);
  return formatPasswordCredential(parameters, salt, hash);
}

/**
 * A fixed, well-formed credential no password verifies against. Verifying a
 * missing or malformed row against it keeps the failure path's CPU cost — and
 * therefore its latency — in the same range as a real mismatch, without paying
 * a scrypt at module load.
 */
const ABSENT_CREDENTIAL = formatPasswordCredential(
  DEFAULT_SCRYPT_PARAMETERS,
  Buffer.alloc(DEFAULT_SCRYPT_PARAMETERS.saltBytes, 0x5a),
  Buffer.alloc(DEFAULT_SCRYPT_PARAMETERS.keyLength, 0),
);

/**
 * Verify a candidate password against a stored credential.
 *
 * Returns false — never throws — for a null, malformed, or unknown-version
 * stored value, and still performs an equivalent derivation so "this user has
 * no password" and "that password is wrong" cost the same.
 */
export async function verifyPassword(password: unknown, stored: string | null | undefined): Promise<boolean> {
  const candidate = typeof password === "string" && password.length > 0 && password.length <= PASSWORD_MAX_LENGTH
    ? password
    : "";
  const parsedStored = parsePasswordCredential(stored);
  const parsed = parsedStored ?? parsePasswordCredential(ABSENT_CREDENTIAL);
  // ABSENT_CREDENTIAL is built from the module's own constants, so this is
  // unreachable; fail closed rather than assert.
  if (!parsed) return false;
  const usable = parsedStored !== null && candidate.length > 0;

  let derived: Buffer;
  try {
    derived = await derive(candidate, parsed.salt, parsed.parameters);
  } catch {
    return false;
  }
  if (derived.length !== parsed.hash.length) return false;
  const matches = timingSafeEqual(derived, parsed.hash);
  return usable && matches;
}
