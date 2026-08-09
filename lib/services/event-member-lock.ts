import { Prisma, type UserRole } from "@prisma/client";

export type EventMemberAuthority = { eventId: string; userId: string };

/**
 * Transaction-scoped authority keys close the otherwise unavoidable
 * missing-row gap in `SELECT ... FOR SHARE`: a concurrent invite could insert
 * a membership after an assignment writer observes no row. All membership
 * readers/writers share this exact, bytewise tuple order.
 */
export function eventMemberAuthorityLockKeys(authorities: readonly EventMemberAuthority[]): string[] {
  const unique = new Map<string, EventMemberAuthority>();
  for (const authority of authorities) {
    unique.set(JSON.stringify([authority.eventId, authority.userId]), authority);
  }
  return [...unique.values()]
    .sort((left, right) => {
      if (left.eventId !== right.eventId) return left.eventId < right.eventId ? -1 : 1;
      return left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0;
    })
    .map(({ eventId, userId }) => `event-member-authority:${eventId}:${userId}`);
}

export async function lockEventMemberAuthorities(
  tx: Prisma.TransactionClient,
  authorities: readonly EventMemberAuthority[],
): Promise<void> {
  for (const key of eventMemberAuthorityLockKeys(authorities)) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
}

export function sortEventMemberUserIds(userIds: readonly string[]): string[] {
  return [...new Set(userIds)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export type LockedEventMember = { userId: string; role: UserRole };

/** Lock existing authority rows only after their advisory keys are held. */
export async function lockExistingEventMembersForShare(
  tx: Prisma.TransactionClient,
  eventId: string,
  userIds: readonly string[],
): Promise<LockedEventMember[]> {
  const sorted = sortEventMemberUserIds(userIds);
  if (sorted.length === 0) return [];
  return tx.$queryRaw<LockedEventMember[]>`
    SELECT "userId", "role"
    FROM "EventMember"
    WHERE "eventId" = ${eventId}
      AND "userId" IN (${Prisma.join(sorted)})
    ORDER BY "userId" COLLATE "C"
    FOR SHARE
  `;
}

/** C17 owns the membership mutation path and therefore takes exclusive rows. */
export async function lockExistingEventMembersForUpdate(
  tx: Prisma.TransactionClient,
  eventId: string,
  userIds: readonly string[],
): Promise<LockedEventMember[]> {
  const sorted = sortEventMemberUserIds(userIds);
  if (sorted.length === 0) return [];
  return tx.$queryRaw<LockedEventMember[]>`
    SELECT "userId", "role"
    FROM "EventMember"
    WHERE "eventId" = ${eventId}
      AND "userId" IN (${Prisma.join(sorted)})
    ORDER BY "userId" COLLATE "C"
    FOR UPDATE
  `;
}
