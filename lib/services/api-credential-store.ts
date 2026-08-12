import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseApiCredentialToken } from "@/lib/services/api-credential";

/**
 * The only place a stored `ApiCredential` secret digest is read for
 * authentication.
 *
 * Splitting this off `lib/services/api-credential.ts` keeps that module pure —
 * no Prisma, no environment — so the token, entropy, and constant-time
 * properties are provable by unit test alone. Everything here is the database
 * half, and it is one statement.
 *
 * ## One indexed point read, never a scan
 *
 * The presented token is parsed first, and the row is fetched by its NON-SECRET
 * `lookupId` on a unique index. That is a single-row index probe: no scan over
 * the event's credentials, no prefix or partial match, and no index anywhere
 * keyed on material derived from the secret. The secret is compared afterwards,
 * in constant time, against the one row that came back.
 *
 * ## Racing a revocation, and why the answer is deterministic
 *
 * A caller can present a credential at the exact moment an organizer revokes
 * it. The outcome is decided by one rule: the authenticating read is a SINGLE
 * statement whose `revokedAt IS NULL` predicate is evaluated by Postgres inside
 * that statement, never by application code afterwards.
 *
 * Under READ COMMITTED — this deployment's default — that statement takes its
 * snapshot when it begins, so exactly two orderings exist:
 *
 *   1. The revoking UPDATE commits BEFORE the read statement begins. The read
 *      sees `revokedAt` set, the predicate excludes the row, no row comes back,
 *      and the request is refused. Revocation wins, and it wins for every
 *      subsequent request, permanently.
 *   2. The revoking UPDATE has not committed when the read statement begins.
 *      The read sees the row as it was actually committed at that instant and
 *      the request is authorized — the correct answer, because the revocation
 *      was not yet a fact of the database when the request was authenticated.
 *      Postgres does not block here either: a plain SELECT never waits on a
 *      concurrent row UPDATE.
 *
 * There is no third case, and in particular no check-then-act window: nothing
 * reads a row here and then decides separately whether it is still live. That
 * is why this must stay one query with the predicate inside it. Moving the
 * `revokedAt` test into TypeScript would reintroduce exactly the gap this
 * comment says does not exist, so `lib/services/api-credential.source.test.ts`
 * pins the predicate to this query.
 *
 * The guarantee is therefore "revoked wins from the moment the revocation
 * commits", not "revoked wins for a request already in flight". Nothing
 * stronger is available without serializing every API read behind the revoke
 * path, which would make revocation the cost of every request.
 */

/** What authentication needs from a stored credential, and nothing more. */
export type ActiveApiCredential = {
  id: string;
  eventId: string;
  secretHash: string;
};

/**
 * Resolve a presented token to its live credential and the digest to compare
 * against, or null.
 *
 * Never distinguishes malformed from unknown from revoked: all three return
 * null here, and the wrong-event case is refused identically upstream.
 */
export async function findActiveApiCredential(token: string): Promise<ActiveApiCredential | null> {
  const parsed = parseApiCredentialToken(token);
  // Input that cannot match any issued token skips a guaranteed-empty query.
  // Not an authorization decision: a well-formed unknown token ends at the very
  // same refusal, one statement later.
  if (!parsed) return null;
  return prisma.apiCredential.findFirst({
    where: { lookupId: parsed.lookupId, revokedAt: null },
    select: { id: true, eventId: true, secretHash: true },
  });
}

/** Advisory-lock class for serializing credential issuance within one event. */
export function apiCredentialCreateLockKey(eventId: string): string {
  return `api-credential-create:${eventId}`;
}

/**
 * Serialize issuance for one event so the active-credential bound is a real
 * bound rather than a suggestion.
 *
 * Counting rows and then inserting is a check-then-act: two admins pressing
 * create together would each count nine and each insert. A transaction-scoped
 * advisory lock keyed on the event makes the count and the insert atomic with
 * respect to each other without locking the table or any credential row, and it
 * is released by commit or rollback, so a failed create cannot strand it.
 */
export async function lockEventApiCredentialIssuance(
  tx: Prisma.TransactionClient,
  eventId: string,
): Promise<void> {
  const key = apiCredentialCreateLockKey(eventId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
