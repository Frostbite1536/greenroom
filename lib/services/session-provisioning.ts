import type { Prisma } from "@prisma/client";

/**
 * Turning an accepted proposal into a confirmed talk (WAVE1-B1).
 *
 * The director's requirement: "after accept, speaker/session/tasks are created
 * automatically". Conversion previously created a `Session` but no
 * `SpeakerTask` rows, so a freshly accepted speaker opened the portal to an
 * empty checklist. Both steps now live here and are shared by the automatic
 * path (accept) and the manual one (`/api/evaluations/convert`), so they cannot
 * drift apart.
 *
 * Every function here expects to run inside a transaction that already holds
 * the per-abstract advisory lock (`lockAbstractForWrite`).
 */

/** Fallback length for an auto-created session when the proposal never stated one. */
export const DEFAULT_SESSION_MINUTES = 30;

/**
 * Session length: what the caller asked for, else what the speaker proposed,
 * else the house default. Accepting a talk must never fail merely because the
 * proposal omitted a duration.
 */
export function resolveSessionDuration(
  proposed: number | null | undefined,
  requested?: number | null,
): number {
  return requested ?? proposed ?? DEFAULT_SESSION_MINUTES;
}

/**
 * The task/speaker cross-product to assign. Speaker ids are de-duplicated and
 * ordering is stable (task order first) so a retry produces the same plan.
 */
export function planTaskAssignments(
  taskIds: readonly string[],
  userIds: readonly string[],
): { taskId: string; userId: string }[] {
  const uniqueUserIds = [...new Set(userIds)];
  const pairs: { taskId: string; userId: string }[] = [];
  for (const taskId of taskIds) {
    for (const userId of uniqueUserIds) {
      pairs.push({ taskId, userId });
    }
  }
  return pairs;
}

type ConvertibleAbstract = {
  id: string;
  eventId: string;
  title: string;
  abstract: string | null;
  format: string | null;
  durationMinutes: number | null;
  speakers: { userId: string; isPrimary: boolean }[];
  session: { id: string } | null;
};

/**
 * Ensure the abstract has its confirmed `Session`, creating it with the
 * proposal's speakers on first call. At most one session per abstract
 * (INV-DOMAIN-001, enforced by the unique `sourceAbstractId`); re-running
 * returns the existing one rather than failing.
 */
export async function provisionSessionForAbstract(
  tx: Prisma.TransactionClient,
  abstract: ConvertibleAbstract,
  requestedDuration?: number | null,
): Promise<{ sessionId: string; created: boolean }> {
  if (abstract.session) {
    return { sessionId: abstract.session.id, created: false };
  }

  const created = await tx.session.create({
    data: {
      eventId: abstract.eventId,
      sourceAbstractId: abstract.id,
      title: abstract.title,
      description: abstract.abstract,
      format: abstract.format,
      durationMinutes: resolveSessionDuration(abstract.durationMinutes, requestedDuration),
    },
  });
  if (abstract.speakers.length > 0) {
    await tx.sessionSpeaker.createMany({
      data: abstract.speakers.map((speaker) => ({
        sessionId: created.id,
        userId: speaker.userId,
        isPrimary: speaker.isPrimary,
      })),
    });
  }
  return { sessionId: created.id, created: true };
}

/**
 * Give every speaker on a confirmed session the event's onboarding checklist.
 *
 * Duplicate-safe and therefore also a backfill: it runs on the idempotent
 * branch too, so talks converted before this existed, and speakers added to an
 * event's checklist later, pick up their rows on the next accept/convert.
 * Returns how many assignments were actually new.
 */
export async function assignOnboardingTasks(
  tx: Prisma.TransactionClient,
  eventId: string,
  sessionId: string,
): Promise<number> {
  const [tasks, speakers] = await Promise.all([
    tx.onboardingTask.findMany({
      where: { eventId },
      select: { id: true },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    }),
    // The confirmed session's roster is authoritative for a talk that is on the
    // programme, and it is what the portal reads.
    tx.sessionSpeaker.findMany({ where: { sessionId }, select: { userId: true } }),
  ]);

  const pairs = planTaskAssignments(
    tasks.map((task) => task.id),
    speakers.map((speaker) => speaker.userId),
  );
  if (pairs.length === 0) return 0;

  // `skipDuplicates` on the composite primary key makes this safe to re-run and
  // safe against a concurrent accept for the same talk.
  const result = await tx.speakerTask.createMany({ data: pairs, skipDuplicates: true });
  return result.count;
}

/**
 * The whole "make it real" step: ensure the session exists, then ensure every
 * speaker on it has the checklist.
 */
export async function provisionAcceptedAbstract(
  tx: Prisma.TransactionClient,
  abstract: ConvertibleAbstract,
  requestedDuration?: number | null,
): Promise<{ sessionId: string; created: boolean; tasksAssigned: number }> {
  const session = await provisionSessionForAbstract(tx, abstract, requestedDuration);
  const tasksAssigned = await assignOnboardingTasks(tx, abstract.eventId, session.sessionId);
  return { ...session, tasksAssigned };
}
