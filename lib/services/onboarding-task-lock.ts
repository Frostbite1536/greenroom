import type { Prisma } from "@prisma/client";

/**
 * Locking for onboarding-task template writes (LOCK-ORDER-v1).
 *
 * Template writes are unusual for an event-owned row: creating or requiring a
 * template fans out `SpeakerTask` rows across every confirmed speaker (C33), so
 * two concurrent organizer actions on the same event would otherwise interleave
 * their fan-outs. The order every writer in this class takes is:
 *
 *   1. the per-event fan-out advisory lock,
 *   2. `FormConfig` FOR SHARE for every linked form the write touches, in
 *      sorted id order,
 *   3. the target `OnboardingTask` FOR UPDATE,
 *   4. fresh reads, then the write and the fan-out.
 *
 * Step 2 before step 3 is the same class order S15 whole-form deletion takes
 * (`FormConfig` FOR UPDATE → `FormField` → `OnboardingTask` FOR UPDATE). Taking
 * them the other way round would deadlock against it, because deleting or
 * retargeting a task's `formConfigId` needs an FK key-share lock on the very
 * `FormConfig` row that path already holds exclusively.
 */

export type LockedOnboardingTask = {
  id: string;
  eventId: string;
  title: string;
  required: boolean;
  formConfigId: string | null;
};

export type LockedTaskFormConfig = { id: string; eventId: string; name: string };

export function taskFanOutLockKey(eventId: string): string {
  return `onboarding-task-fanout:${eventId}`;
}

/**
 * Serialize the template writes that fan out for one event. `assignOnboardingTasks`
 * is duplicate-safe on its own, but this keeps two organizer actions from
 * reporting overlapping "assigned N" counts for the same rows and keeps the
 * whole class of template writes single-file per event.
 */
export async function lockEventTaskFanOut(
  tx: Prisma.TransactionClient,
  eventId: string,
): Promise<void> {
  const key = taskFanOutLockKey(eventId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

/**
 * Lock every `FormConfig` this write may reference, in sorted id order so two
 * writers touching the same pair cannot deadlock against each other. FOR SHARE
 * is enough: we only need the row to still exist and still belong to this event
 * when the link is written, and it must conflict with the exclusive lock the
 * form-deletion path holds.
 */
export async function lockFormConfigsForTaskWrite(
  tx: Prisma.TransactionClient,
  formConfigIds: readonly (string | null | undefined)[],
): Promise<Map<string, LockedTaskFormConfig>> {
  const unique = [...new Set(formConfigIds.filter((id): id is string => typeof id === "string" && id !== ""))].sort();
  const locked = new Map<string, LockedTaskFormConfig>();
  for (const id of unique) {
    const rows = await tx.$queryRaw<LockedTaskFormConfig[]>`
      SELECT "id", "eventId", "name" FROM "FormConfig" WHERE "id" = ${id} FOR SHARE
    `;
    if (rows[0]) locked.set(rows[0].id, rows[0]);
  }
  return locked;
}

/**
 * Read the stored link without locking, so the caller can take the `FormConfig`
 * class first. The value is re-checked against the locked row afterwards; a
 * mismatch means a concurrent retarget committed in between and the caller must
 * refuse rather than proceed with the wrong form locked.
 */
export async function peekTaskFormConfigId(
  tx: Prisma.TransactionClient,
  taskId: string,
): Promise<{ formConfigId: string | null } | null> {
  return tx.onboardingTask.findUnique({ where: { id: taskId }, select: { formConfigId: true } });
}

/** The exclusive lock every template mutation holds before it re-reads and writes. */
export async function lockOnboardingTaskForWrite(
  tx: Prisma.TransactionClient,
  taskId: string,
): Promise<LockedOnboardingTask | null> {
  const rows = await tx.$queryRaw<LockedOnboardingTask[]>`
    SELECT "id", "eventId", "title", "required", "formConfigId"
    FROM "OnboardingTask" WHERE "id" = ${taskId} FOR UPDATE
  `;
  return rows[0] ?? null;
}
