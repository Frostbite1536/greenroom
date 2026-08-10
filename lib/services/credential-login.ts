import type { UserRole } from "@prisma/client";
import type { DemoSession } from "@/lib/auth";
import { PASSWORD_MAX_LENGTH, verifyPassword } from "@/lib/password-credential";

/**
 * Email + password sign-in policy (D-C5-6 ruling 2).
 *
 * Pure and dependency-injected so it is testable without a database: the route
 * supplies `findUser`, this module owns the decision. It issues exactly the
 * session shape the one-click persona flow issues, with the role resolved from
 * the user's own `EventMember` rows — never from anything the client sent.
 *
 * The single most important property here is **indistinguishability**: unknown
 * address, wrong password, a user with no credential, and a credentialed user
 * with no membership all return `null`, having done the same work. There is one
 * refusal and it never says which case it was.
 */

/** Addresses are stored lowercased; RFC 5321 caps a path at 254 characters. */
export const LOGIN_EMAIL_MAX_LENGTH = 254;

export type CredentialMembership = {
  role: UserRole;
  event: { id: string; name: string; slug: string };
};

export type CredentialUserRecord = {
  id: string;
  name: string;
  email: string;
  passwordHash: string | null;
  memberships: CredentialMembership[];
};

/**
 * Deterministic ordering when an identity holds several memberships. The
 * product is single-event today, so this is a tie-break rule rather than a
 * feature: land the user on their most capable home, then order by event id so
 * the choice never depends on row order. `getResolvedSession` re-derives the
 * role from the chosen event on every later request, so this only decides where
 * the sign-in lands.
 */
const ROLE_AUTHORITY: Record<UserRole, number> = { ADMIN: 0, EVALUATOR: 1, SPEAKER: 2 };

export function pickCredentialMembership(
  memberships: readonly CredentialMembership[],
): CredentialMembership | null {
  const ordered = [...memberships].sort(
    (left, right) =>
      (ROLE_AUTHORITY[left.role] ?? Number.MAX_SAFE_INTEGER) - (ROLE_AUTHORITY[right.role] ?? Number.MAX_SAFE_INTEGER) ||
      left.event.id.localeCompare(right.event.id),
  );
  return ordered[0] ?? null;
}

/**
 * Normalize a submitted address to the form used for both the `User` lookup and
 * the per-email throttle bucket. Anything unusable becomes `""` — which is a
 * stable bucket key that simply never matches a row — rather than a truncated
 * value that would silently change which bucket an attempt is charged to.
 */
export function normalizeLoginEmail(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > LOGIN_EMAIL_MAX_LENGTH ? "" : trimmed;
}

/** Bound the submitted secret at the boundary; scrypt cost is length-independent. */
export function normalizeLoginPassword(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.length > PASSWORD_MAX_LENGTH ? "" : raw;
}

/**
 * Resolve a credential attempt to a session, or `null`.
 *
 * `verify` is injected only so tests can use a cheap stand-in; production uses
 * the real scrypt verification. The verification runs on **every** path,
 * including "no such user", so the absent case costs a derivation too.
 */
export async function resolveCredentialSession(input: {
  email: string;
  password: string;
  findUser: (email: string) => Promise<CredentialUserRecord | null>;
  verify?: (password: string, stored: string | null) => Promise<boolean>;
}): Promise<DemoSession | null> {
  const verify = input.verify ?? verifyPassword;
  const email = normalizeLoginEmail(input.email);
  const password = normalizeLoginPassword(input.password);

  const user = email.length > 0 ? await input.findUser(email) : null;
  // Deliberately unconditional: a null user still verifies against a null
  // stored value, which the credential module answers with an equivalent
  // derivation. Short-circuiting here would reintroduce the timing oracle.
  const matches = await verify(password, user?.passwordHash ?? null);
  if (!user || !matches) return null;

  const membership = pickCredentialMembership(user.memberships);
  // A credentialed identity with no membership has nowhere to land. Refusing it
  // with the same generic failure keeps provisioning state private.
  if (!membership) return null;

  return {
    user: { id: user.id, name: user.name, email: user.email },
    event: membership.event,
    role: membership.role,
  };
}
