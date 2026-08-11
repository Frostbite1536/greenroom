import type { Prisma } from "@prisma/client";
import { lockEventTaskFanOut } from "@/lib/services/onboarding-task-lock";

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
 * What each function here expects of its caller differs, so it is stated per
 * group rather than once for the file:
 *
 *  - **The abstract-derived writers** (`provisionSessionForAbstract`,
 *    `provisionAcceptedAbstract`) run inside a transaction that already holds
 *    that abstract's advisory lock (`lockAbstractForWrite`). Both callers —
 *    `POST /api/evaluations/decisions` and `POST /api/evaluations/convert` —
 *    take it before they read the row these are handed.
 *  - **`provisionGuaranteedSession`** has no abstract, and so no abstract lock.
 *    Its route authorizes the event and checks every speaker against the roster
 *    first instead, under the C17 keys.
 *  - **The pure helpers** (`resolveSessionDuration`, `planTaskAssignments`,
 *    `reconciledSessionFields`, `newSessionData`, `newGuaranteedSessionData`)
 *    touch no database and expect nothing at all.
 *
 * The two ENTRY points — `provisionAcceptedAbstract` and
 * `provisionGuaranteedSession` — take the per-event onboarding fan-out lock
 * themselves, as their first act. See each for why; the short version is that
 * provisioning maintains the same task × speaker cross-product the template
 * writers maintain, from the other end, so it belongs to their lock class
 * (LOCK-ORDER-v1, C33).
 */

/** Fallback length for an auto-created session when the proposal never stated one. */
export const DEFAULT_SESSION_MINUTES = 30;

/** Bounds each reconciliation read and insert without omitting any assignments. */
export const TASK_ASSIGNMENT_PAGE_SIZE = 50;

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
  categoryId: string | null;
  speakers: { userId: string; isPrimary: boolean }[];
  session: { id: string; categoryId: string | null; description: string | null } | null;
};

export type ReconciledSessionFields = {
  categoryId?: string | null;
  description?: string | null;
};

/**
 * The write that would bring an existing Session back in line with its
 * proposal, or `null` when they already agree.
 *
 * Returning `null` for an unchanged talk is the point, not an optimization: a
 * re-run that writes nothing leaves `updatedAt` alone, so "the admin reconvened
 * this talk" and "the admin changed this talk" stay distinguishable in the row.
 *
 * Two fields reconcile, and they reconcile by different rules:
 *
 *  - **Topic** is symmetric. The proposal is authoritative in both directions,
 *    so clearing the proposal's category really does clear the talk's.
 *  - **Summary** is one-way. A proposal that carries an attendee-facing summary
 *    pushes it onto the talk; a proposal with a blank summary writes *nothing*.
 *    The asymmetry is deliberate: the public description is the one field an
 *    organizer plausibly hand-writes on the Session itself (a keynote has no
 *    source abstract at all), and a re-run must never silently blank an
 *    admin-authored programme entry because the proposal's field was empty.
 */
export function reconciledSessionFields(
  abstract: { categoryId: string | null; abstract: string | null },
  session: { categoryId: string | null; description: string | null },
): ReconciledSessionFields | null {
  const data: ReconciledSessionFields = {};

  if (abstract.categoryId !== session.categoryId) data.categoryId = abstract.categoryId;

  // Trimmed before comparing so whitespace-only edits are not writes, and so a
  // proposal whose summary is only spaces counts as absent rather than as an
  // instruction to blank the talk.
  const summary = abstract.abstract?.trim() || null;
  if (summary !== null && summary !== session.description) data.description = summary;

  return Object.keys(data).length > 0 ? data : null;
}

/**
 * Everything a brand-new `Session` copies off the accepted proposal.
 *
 * Pure and exported so the copy list is asserted without a database: what a
 * talk inherits from its proposal is a product rule, and a field silently
 * dropped here is invisible until an organizer notices it missing on the
 * public agenda — which is exactly how the category was lost.
 */
export function newSessionData(
  abstract: ConvertibleAbstract,
  requestedDuration?: number | null,
): {
  eventId: string;
  sourceAbstractId: string;
  title: string;
  description: string | null;
  format: string | null;
  durationMinutes: number;
  categoryId: string | null;
} {
  return {
    eventId: abstract.eventId,
    sourceAbstractId: abstract.id,
    title: abstract.title,
    description: abstract.abstract,
    format: abstract.format,
    durationMinutes: resolveSessionDuration(abstract.durationMinutes, requestedDuration),
    // The topic the speaker chose survives acceptance. Without this the label
    // was lost at exactly the moment a proposal became a talk, and every agenda
    // surface fell back to an unlabelled colour.
    categoryId: abstract.categoryId,
  };
}

/**
 * Ensure the abstract has its confirmed `Session`, creating it with the
 * proposal's speakers on first call. At most one session per abstract
 * (INV-DOMAIN-001, enforced by the unique `sourceAbstractId`); re-running
 * returns the existing one rather than failing.
 *
 * **Re-running also reconciles the topic and the public summary, and nothing
 * else.** A proposal's category can legitimately change after acceptance, which
 * left the Session carrying a stale topic on the public agenda with no way to
 * repair it. The summary is here for the same reason and one worse: a Session
 * created before the copy list carried `description` has *no* attendee-facing
 * prose at all, so the public programme showed either nothing or whatever
 * internal note happened to be in the column.
 *
 * Which paths reconcile, and which deliberately do not:
 *
 *  - **Reconciles** — both callers of this function, and only those:
 *    `POST /api/evaluations/decisions` re-accepting an already-accepted
 *    abstract, and `POST /api/evaluations/convert`. Both are
 *    `requireContext(["ADMIN"])`, so the write is always an organizer acting on
 *    their own programme.
 *  - **Does not reconcile** — the speaker's own edit
 *    (`PATCH /api/cfp/submissions/:abstractId`, authorized by
 *    `isAbstractSpeaker`). Per INV-EDIT-001 a speaker edit never silently
 *    mutates its linked Session; C18 owns that reconciliation handoff, and
 *    propagating here would let a speaker change the public programme without
 *    an organizer ever seeing it. The organizer's re-run above is the repair.
 *  - **Nothing to reconcile** — the anonymous draft upsert (DRAFT rows only)
 *    and the admin CSV import (DRAFT/SUBMITTED only). A Session exists only
 *    after acceptance, so neither can ever face one.
 *
 * Title, format and duration are deliberately left alone: the convert route
 * already documents that a requested duration never mutates an existing
 * Session, and scheduling owns later duration changes.
 */
export async function provisionSessionForAbstract(
  tx: Prisma.TransactionClient,
  abstract: ConvertibleAbstract,
  requestedDuration?: number | null,
): Promise<{
  sessionId: string;
  created: boolean;
  topicReconciled: boolean;
  summaryReconciled: boolean;
}> {
  if (abstract.session) {
    const fields = reconciledSessionFields(abstract, abstract.session);
    if (fields) {
      await tx.session.update({ where: { id: abstract.session.id }, data: fields });
    }
    return {
      sessionId: abstract.session.id,
      created: false,
      topicReconciled: fields !== null && "categoryId" in fields,
      summaryReconciled: fields !== null && "description" in fields,
    };
  }

  const created = await tx.session.create({
    data: newSessionData(abstract, requestedDuration),
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
  // A session created from the proposal a moment ago cannot be out of step
  // with it, so there is nothing to reconcile on this branch.
  return { sessionId: created.id, created: true, topicReconciled: false, summaryReconciled: false };
}

/** What a directly authored talk carries, before any database work. */
export type GuaranteedSessionFields = {
  title: string;
  description?: string | null;
  format?: string | null;
  durationMinutes: number;
  speakers: readonly { userId: string; isPrimary: boolean }[];
};

/**
 * Everything a `Session` authored directly on the programme is created with.
 *
 * Pure and exported for the same reason `newSessionData` is: what a keynote or
 * a sponsor slot starts life as is a product rule, and the two fields that make
 * this row *different* from an accepted proposal's are both easy to lose in a
 * refactor and invisible until an organizer notices.
 *
 *  - **`sourceAbstractId` is null**, which is what makes this a guaranteed
 *    session at all (INV-DOMAIN-001: at most one session per abstract; a talk
 *    with no abstract consumes none of that budget). It is stated explicitly
 *    rather than omitted so the intent survives a reader who is looking for it.
 *  - **`contentStatus` is `DRAFT`**, overriding the column's `PUBLISHED`
 *    default. That default exists because every *scheduled* session was already
 *    public when the column was added; a talk being typed into a dialog is not,
 *    and announcing it on the public programme mid-keystroke is not a default
 *    anyone asked for. The admin publishes it with the existing PATCH.
 *
 * `categoryId` is absent, not null-by-accident: a directly authored talk has no
 * proposal to inherit a topic from, which is exactly the case
 * `AgendaSession.category` already documents as "null for a directly authored
 * session".
 */
export function newGuaranteedSessionData(
  eventId: string,
  input: GuaranteedSessionFields,
): {
  eventId: string;
  sourceAbstractId: null;
  title: string;
  description: string | null;
  format: string | null;
  durationMinutes: number;
  contentStatus: "DRAFT";
} {
  return {
    eventId,
    sourceAbstractId: null,
    title: input.title,
    // Trimmed-to-absent becomes an explicit null rather than an empty string, so
    // the public programme's "has a summary" test stays a null check everywhere.
    description: input.description?.trim() || null,
    format: input.format?.trim() || null,
    durationMinutes: input.durationMinutes,
    contentStatus: "DRAFT",
  };
}

/**
 * Create a talk that has no source proposal, with its speakers and their
 * onboarding checklist — the same "make it real" step acceptance takes, minus
 * the abstract.
 *
 * This is deliberately the *only* way `POST /api/agenda/sessions` reaches
 * `Session`/`SessionSpeaker`. Acceptance's provisioning already owns two rules
 * that a second writer would drift from within a release: the roster is
 * snapshotted onto `SessionSpeaker` in one statement, and every speaker on a
 * confirmed session gets the event's onboarding checklist (INV-TASK-001). A
 * keynote speaker is a confirmed speaker, so the checklist is not optional for
 * them either — `assignOnboardingTasks` is the same call, idempotent as ever.
 *
 * Expects to run inside a transaction that has already authorized the event and
 * confirmed every `userId` is on this event's roster.
 *
 * **The per-event fan-out lock is taken here, first, before the session exists**
 * (LOCK-ORDER-v1, C33). Creating a confirmed talk is the other half of the
 * cross-product `POST /api/admin/tasks` maintains: that route locks, creates a
 * required template, and fans it out across the event's existing sessions, while
 * this one creates a session and fans the event's existing templates across its
 * speakers. Each reads exactly what the other is about to write, so without a
 * shared lock two overlapping transactions each read a snapshot in which the
 * other's row does not exist yet, both commit, and the new confirmed speaker is
 * left without the new required task — INV-TASK-001 broken with no duplicate for
 * `skipDuplicates` to catch, because the failure is an absence. Taking it before
 * `session.create` rather than around the fan-out alone keeps every writer in
 * this class acquiring it first and holding no row locks while it waits.
 */
export async function provisionGuaranteedSession(
  tx: Prisma.TransactionClient,
  eventId: string,
  input: GuaranteedSessionFields,
): Promise<{ sessionId: string; speakersAdded: number; tasksAssigned: number }> {
  await lockEventTaskFanOut(tx, eventId);

  const created = await tx.session.create({ data: newGuaranteedSessionData(eventId, input) });

  if (input.speakers.length > 0) {
    await tx.sessionSpeaker.createMany({
      data: input.speakers.map((speaker) => ({
        sessionId: created.id,
        userId: speaker.userId,
        isPrimary: speaker.isPrimary,
      })),
    });
  }

  // Reads the rows just written, never the request, so a talk created with no
  // speakers assigns nothing rather than fanning a checklist out to no one.
  const tasksAssigned = await assignOnboardingTasks(tx, eventId, created.id);

  return { sessionId: created.id, speakersAdded: input.speakers.length, tasksAssigned };
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
  let tasksAfter: string | undefined;
  let assigned = 0;

  do {
    const tasks = await tx.onboardingTask.findMany({
      where: { eventId, ...(tasksAfter ? { id: { gt: tasksAfter } } : {}) },
      select: { id: true },
      orderBy: { id: "asc" },
      take: TASK_ASSIGNMENT_PAGE_SIZE,
    });
    if (tasks.length === 0) break;

    let speakersAfter: string | undefined;
    do {
      // The confirmed session's roster is authoritative for a talk that is on
      // the programme, and it is what the portal reads.
      const speakers = await tx.sessionSpeaker.findMany({
        where: {
          sessionId,
          ...(speakersAfter ? { userId: { gt: speakersAfter } } : {}),
        },
        select: { userId: true },
        orderBy: { userId: "asc" },
        take: TASK_ASSIGNMENT_PAGE_SIZE,
      });
      if (speakers.length === 0) break;

      const pairs = planTaskAssignments(
        tasks.map((task) => task.id),
        speakers.map((speaker) => speaker.userId),
      );
      // `skipDuplicates` on the composite primary key makes this safe to re-run
      // and safe against concurrent retries. Each insert is bounded to
      // PAGE_SIZE² rows while the loops reconcile every page.
      const result = await tx.speakerTask.createMany({ data: pairs, skipDuplicates: true });
      assigned += result.count;
      speakersAfter = speakers.at(-1)?.userId;
    } while (speakersAfter);

    tasksAfter = tasks.at(-1)?.id;
  } while (tasksAfter);

  return assigned;
}

/**
 * The whole "make it real" step: ensure the session exists, then ensure every
 * speaker on it has the checklist.
 *
 * Same C33 race, same first act: the per-event fan-out lock, before the session
 * is created or reconciled. An acceptance and a concurrent "make this template
 * required" would otherwise each miss the other's uncommitted row and leave a
 * freshly confirmed speaker without a required task (INV-TASK-001). Its callers
 * (`POST /api/evaluations/decisions`, `POST /api/evaluations/convert`) already
 * hold the per-abstract lock when they get here, so the order is
 * abstract → fan-out; the four writers on the other side of this lock take no
 * abstract lock at all, so the graph gains no cycle.
 */
export async function provisionAcceptedAbstract(
  tx: Prisma.TransactionClient,
  abstract: ConvertibleAbstract,
  requestedDuration?: number | null,
): Promise<{
  sessionId: string;
  created: boolean;
  topicReconciled: boolean;
  summaryReconciled: boolean;
  tasksAssigned: number;
}> {
  await lockEventTaskFanOut(tx, abstract.eventId);

  const session = await provisionSessionForAbstract(tx, abstract, requestedDuration);
  const tasksAssigned = await assignOnboardingTasks(tx, abstract.eventId, session.sessionId);
  return { ...session, tasksAssigned };
}
