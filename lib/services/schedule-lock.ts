import { Prisma } from "@prisma/client";

/**
 * Transactional scheduling snapshot for bulk schedule writes (S3 under
 * `LOCK-ORDER-v1`).
 *
 * A conflict check is a predicate over *every* slot in an event, so the row
 * locks a writer can take are not enough on their own: `FOR UPDATE` cannot lock
 * a row that does not exist yet, and the row a concurrent writer is about to
 * insert is exactly the one that would invalidate the check. The advisory
 * predicate keys below close that gap — they name the predicate, not the rows.
 *
 * Order, and every writer must take it in this order or not at all:
 *
 *   1. `schedule-write:<eventId>` — the event-wide predicate every conflict
 *      read actually evaluates.
 *   2. sorted `schedule-day:<eventId>:<dayKey>` keys — the finer partition, so
 *      a future per-day writer has a documented key to take. Sorted ordinally
 *      so two writers holding overlapping day sets cannot deadlock. Day keys are
 *      the placement's **UTC** calendar day, deliberately: a partition key
 *      derived from the event's timezone would move when an administrator edits
 *      that timezone, and a lock key that moves is not a lock key.
 *   3. the `Event` row `FOR SHARE` — the configuration parent. Timezone and the
 *      event date range decide which days exist, where the programme window
 *      falls, and which start times are on the lattice, so a placement validated
 *      against an unlocked copy of them is validated against nothing. It is
 *      taken first among the row locks because `LOCK-ORDER-v1` puts parent and
 *      configuration rows before the resources they scope.
 *   4. room and speaker resources — `Room` and `SessionSpeaker` `FOR SHARE`, in
 *      sorted id order. Sharing is the right strength: this path must observe a
 *      stable room and speaker set, not mutate it, and `FOR SHARE` on `Room`
 *      still excludes the settings delete path, which takes `FOR UPDATE`.
 *   5. `Session` rows `FOR SHARE`, then the event's `ScheduleSlot` rows
 *      `FOR UPDATE` — the authoritative existing-placement set the caller
 *      re-reads and writes against.
 *
 * Why `Event` first is safe against the settings writer rather than merely
 * untested: `PATCH /api/admin/settings` takes `Event FOR UPDATE` as the first
 * statement of its transaction and acquires no second lock class at all
 * (`app/api/admin/settings/route.ts`), and the room routes take `Room FOR
 * UPDATE` alone. Neither can hold a class this path wants while waiting on a
 * class this path holds, so no cycle exists in either direction. `FOR SHARE`
 * and `FOR UPDATE` do conflict, which is the point: a settings PATCH that
 * arrives mid-apply waits, and an apply that arrives mid-PATCH waits and then
 * re-reads the committed boundaries — where the changed timezone or dates flow
 * into the fingerprint and the plan is refused rather than written against
 * boundaries that no longer exist.
 *
 * `COLLATE "C"` pins ordinal ordering so the lock sequence never depends on the
 * database's locale (the same correction `LOCK-ORDER-v1` made elsewhere).
 */

/** Ordinal, never locale-dependent. */
function ordinal(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * The exact advisory key sequence, exported so the order is asserted rather
 * than described. Step 1 then step 2 of the order above.
 */
export function scheduleWriteLockKeys(eventId: string, dayKeys: readonly string[]): string[] {
  return [
    `schedule-write:${eventId}`,
    ...ordinal(dayKeys).map((dayKey) => `schedule-day:${eventId}:${dayKey}`),
  ];
}

/** Step 1–2: the event-wide predicate key, then the sorted day predicate keys. */
export async function lockScheduleWrite(
  tx: Prisma.TransactionClient,
  eventId: string,
  dayKeys: readonly string[] = [],
): Promise<void> {
  for (const key of scheduleWriteLockKeys(eventId, dayKeys)) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
}

/**
 * The placement's UTC calendar day, the derivation every taker of a
 * `schedule-day` key must use. Timezone-independent on purpose (see step 2).
 */
export function scheduleDayKeyForInstant(startsAt: string | Date): string {
  return new Date(startsAt).toISOString().slice(0, 10);
}

export type LockedEvent = {
  id: string;
  timezone: string;
  startsAt: Date | null;
  endsAt: Date | null;
};

/**
 * Step 3: the configuration parent. Everything that decides *where* a placement
 * may legally land — the timezone the day and window are reckoned in, and the
 * event's own date range — is read here, under the lock, and nowhere else.
 * Returns `null` when the event is gone, which the caller reports as a 404.
 */
export async function lockEventForShare(
  tx: Prisma.TransactionClient,
  eventId: string,
): Promise<LockedEvent | null> {
  const [locked] = await tx.$queryRaw<LockedEvent[]>`
    SELECT "id", "timezone", "startsAt", "endsAt"
    FROM "Event"
    WHERE "id" = ${eventId}
    FOR SHARE
  `;
  return locked ?? null;
}

export type LockedRoom = { id: string };

/**
 * Step 4a: the rooms this write targets, scoped to the event. A room that is
 * absent from the result either does not exist or belongs to another event —
 * the caller cannot tell the two apart, and must not disclose which.
 */
export async function lockScheduleRoomsForShare(
  tx: Prisma.TransactionClient,
  eventId: string,
  roomIds: readonly string[],
): Promise<LockedRoom[]> {
  const sorted = ordinal(roomIds);
  if (sorted.length === 0) return [];
  return tx.$queryRaw<LockedRoom[]>`
    SELECT "id"
    FROM "Room"
    WHERE "eventId" = ${eventId}
      AND "id" IN (${Prisma.join(sorted)})
    ORDER BY "id" COLLATE "C"
    FOR SHARE
  `;
}

export type LockedSessionSpeaker = { sessionId: string; userId: string };

/**
 * Step 4b: the speaker assignments of the sessions this write targets. Held so
 * a concurrent speaker change cannot land between the conflict recomputation
 * and the insert and make a committed placement double-book someone.
 */
export async function lockScheduleSpeakersForShare(
  tx: Prisma.TransactionClient,
  sessionIds: readonly string[],
): Promise<LockedSessionSpeaker[]> {
  const sorted = ordinal(sessionIds);
  if (sorted.length === 0) return [];
  return tx.$queryRaw<LockedSessionSpeaker[]>`
    SELECT "sessionId", "userId"
    FROM "SessionSpeaker"
    WHERE "sessionId" IN (${Prisma.join(sorted)})
    ORDER BY "sessionId" COLLATE "C", "userId" COLLATE "C"
    FOR SHARE
  `;
}

export type LockedSession = { id: string; eventId: string; durationMinutes: number };

/** Step 5a: the target `Session` rows, so ownership and duration cannot move. */
export async function lockScheduleSessionsForShare(
  tx: Prisma.TransactionClient,
  sessionIds: readonly string[],
): Promise<LockedSession[]> {
  const sorted = ordinal(sessionIds);
  if (sorted.length === 0) return [];
  return tx.$queryRaw<LockedSession[]>`
    SELECT "id", "eventId", "durationMinutes"
    FROM "Session"
    WHERE "id" IN (${Prisma.join(sorted)})
    ORDER BY "id" COLLATE "C"
    FOR SHARE
  `;
}

export type LockedScheduleSlot = {
  id: string;
  sessionId: string;
  roomId: string;
  startsAt: Date;
  endsAt: Date;
};

/**
 * Step 5b: every existing placement in the event, exclusively. This is the set
 * the conflict recomputation is evaluated against, so it is locked whole rather
 * than by target: a slot in a room this plan never touches can still be the one
 * a shared speaker collides with.
 */
export async function lockEventScheduleSlotsForUpdate(
  tx: Prisma.TransactionClient,
  eventId: string,
): Promise<LockedScheduleSlot[]> {
  return tx.$queryRaw<LockedScheduleSlot[]>`
    SELECT "id", "sessionId", "roomId", "startsAt", "endsAt"
    FROM "ScheduleSlot"
    WHERE "eventId" = ${eventId}
    ORDER BY "id" COLLATE "C"
    FOR UPDATE
  `;
}
