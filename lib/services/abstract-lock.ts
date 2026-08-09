import type { Prisma } from "@prisma/client";

/**
 * Per-abstract write serialization.
 *
 * A speaker PATCH, an admin decision, and abstract-to-session conversion can
 * all touch the same abstract concurrently. Abstract-only writers acquire
 * this transaction-scoped advisory lock directly. A writer that also locks a
 * FormConfig/FormField must take those earlier LOCK-ORDER-v1 classes first,
 * then this lock, and re-read the row after the final lock. That prevents a
 * status or "no session yet" check from going stale between read and write.
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
