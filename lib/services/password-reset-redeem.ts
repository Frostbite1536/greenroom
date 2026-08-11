import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password-credential";
import { getServerSigningSecret } from "@/lib/server-signing";
import type { CredentialMembership } from "@/lib/services/credential-login";
import { parsePasswordResetToken, verifyPasswordResetToken } from "@/lib/services/password-reset-token";

/**
 * Turn a submitted reset token into the account it names, or into nothing.
 *
 * One resolver, used by both the `/reset` page (which decides whether to render
 * a form at all) and `POST /api/auth/reset` (which decides whether to write).
 * Sharing it is what makes the page's answer and the route's answer the same
 * answer — a page that rendered a form the route would refuse would be a bug
 * that only ever showed up as a confusing dead end.
 *
 * **Every failure is the same failure.** Malformed, expired, wrong signature,
 * unknown user, no credential, and already-spent all return `null`. The caller
 * has exactly one refusal to render, which is the whole point: a token that has
 * been used and a token that was never valid must be indistinguishable, or the
 * link becomes a way to test whether a reset was recently completed.
 *
 * This is also the only place `passwordHash` is read for the reset flow — the
 * digest never leaves this module, and the returned record deliberately does
 * not carry it.
 */

export type ResolvedPasswordReset = {
  user: { id: string; name: string; email: string };
  memberships: CredentialMembership[];
};

type PasswordResetRecord = ResolvedPasswordReset & { passwordHash: string };

/** Read and verify the credential while keeping its stored hash in this module. */
async function readPasswordResetRecord(
  raw: unknown,
  now = new Date(),
): Promise<PasswordResetRecord | null> {
  const secret = getServerSigningSecret();
  if (!secret) return null;

  // Structure and expiry first: a hostile query string is bounded and parsed
  // before it can cost a database round trip.
  const parts = parsePasswordResetToken(raw, now);
  if (!parts) return null;

  const user = await prisma.user.findUnique({
    where: { id: parts.userId },
    select: {
      id: true,
      name: true,
      email: true,
      passwordHash: true,
      memberships: { select: { role: true, event: { select: { id: true, name: true, slug: true } } } },
    },
  });
  if (!user?.passwordHash) return null;

  // The signature is re-derived from the credential as it stands right now, so a
  // token minted against a previous hash — including the one that was just
  // spent to change it — cannot verify. Use-once by construction.
  if (!verifyPasswordResetToken(parts, user.passwordHash, secret)) return null;

  return {
    user: { id: user.id, name: user.name, email: user.email },
    memberships: user.memberships,
    passwordHash: user.passwordHash,
  };
}

function withoutCredential(record: PasswordResetRecord): ResolvedPasswordReset {
  return { user: record.user, memberships: record.memberships };
}

export async function resolvePasswordResetToken(
  raw: unknown,
  now = new Date(),
): Promise<ResolvedPasswordReset | null> {
  const record = await readPasswordResetRecord(raw, now);
  return record ? withoutCredential(record) : null;
}

/**
 * Spend one valid token and replace its credential exactly once.
 *
 * Scrypt runs only after a valid token has been established, and outside a
 * transaction. The conditional update is the consume point: concurrent
 * redeemers may both observe the old hash, but PostgreSQL rechecks this WHERE
 * predicate after the first update commits, so exactly one can update one row.
 * Only that winner receives the safe identity projection used to issue a
 * session. The stored hash never leaves this module.
 */
export async function consumePasswordResetToken(
  raw: unknown,
  password: string,
  now = new Date(),
): Promise<ResolvedPasswordReset | null> {
  const record = await readPasswordResetRecord(raw, now);
  if (!record) return null;

  const replacementHash = await hashPassword(password);
  const consumed = await prisma.user.updateMany({
    where: { id: record.user.id, passwordHash: record.passwordHash },
    data: { passwordHash: replacementHash },
  });
  return consumed.count === 1 ? withoutCredential(record) : null;
}
