import type { Prisma } from "@prisma/client";
import { assignOnboardingTasks, TASK_ASSIGNMENT_PAGE_SIZE } from "@/lib/services/session-provisioning";

/**
 * C33: every confirmed speaker holds the event's current checklist.
 *
 * A `Session` exists exactly when an abstract was accepted or a talk was
 * guaranteed, so the event's sessions are the confirmed cohort — the same
 * definition `/admin/speakers` uses to decide who is on the onboarding list.
 *
 * This deliberately does **not** reimplement the assignment step. It pages the
 * event's sessions and hands each one to `assignOnboardingTasks`, the existing
 * idempotent fan-out that the accept and convert paths already share, so a
 * template created here and a talk accepted a minute later cannot drift apart.
 * `skipDuplicates` inside that helper makes the whole thing safe to re-run, so
 * this is both the "assign to all confirmed speakers" action and the backfill a
 * newly required template must perform before it can report anyone as Ready.
 */
export const CONFIRMED_SESSION_PAGE_SIZE = TASK_ASSIGNMENT_PAGE_SIZE;

export type TaskBackfillResult = {
  /** Confirmed sessions reconciled. */
  sessions: number;
  /** Assignments that were actually new — 0 means everyone already had them. */
  assigned: number;
};

export async function backfillConfirmedSpeakerTasks(
  tx: Prisma.TransactionClient,
  eventId: string,
  assign: typeof assignOnboardingTasks = assignOnboardingTasks,
): Promise<TaskBackfillResult> {
  let after: string | undefined;
  let sessions = 0;
  let assigned = 0;

  do {
    const page = await tx.session.findMany({
      where: { eventId, ...(after ? { id: { gt: after } } : {}) },
      select: { id: true },
      orderBy: { id: "asc" },
      take: CONFIRMED_SESSION_PAGE_SIZE,
    });
    if (page.length === 0) break;

    for (const session of page) {
      assigned += await assign(tx, eventId, session.id);
      sessions++;
    }
    after = page.at(-1)?.id;
  } while (after);

  return { sessions, assigned };
}
