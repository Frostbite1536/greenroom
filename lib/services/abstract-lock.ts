import type { Prisma } from "@prisma/client";

/**
 * Per-abstract write serialization.
 *
 * A speaker PATCH, an admin decision, and abstract-to-session conversion can
 * all touch the same abstract concurrently. Each writer takes this
 * transaction-scoped advisory lock first and re-reads the row inside its
 * transaction, so a status check or "no session yet" check cannot go stale
 * between read and write (the TOCTOU class Greptile flagged on PR #8).
 * Same pattern as the CSV-import identity lock and the seed lock.
 */
export function abstractWriteLockKey(abstractId: string): string {
  return `abstract-write:${abstractId}`;
}

export async function lockAbstractForWrite(
  tx: Prisma.TransactionClient,
  abstractId: string,
): Promise<void> {
  const key = abstractWriteLockKey(abstractId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
