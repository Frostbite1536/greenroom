import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { onboardingTaskCreateSchema, onboardingTaskUpdateSchema } from "@/types/api";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { assertEventQueryBound, OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import { requireEventOwnedRow } from "@/lib/services/event-owned-row";
import { backfillConfirmedSpeakerTasks } from "@/lib/services/onboarding-task-backfill";
import {
  decideOnboardingTaskDeletion,
  startedTaskAssignmentWhere,
} from "@/lib/services/onboarding-task-deletion";
import {
  lockEventTaskFanOut,
  lockFormConfigsForTaskWrite,
  lockOnboardingTaskForWrite,
  peekTaskFormConfigId,
  type LockedTaskFormConfig,
} from "@/lib/services/onboarding-task-lock";
import {
  compareOnboardingTasks,
  serializeOnboardingTask,
  taskDueAtFromDateKey,
  type OnboardingTaskView,
} from "@/lib/services/onboarding-task-view";

export const dynamic = "force-dynamic";

/**
 * Onboarding-task template CRUD (CNT-01/CNT-07/SPK-05).
 *
 * ADMIN-only and event-scoped from the session, never from the body: the
 * caller supplies a task id, and the stored `eventId` is re-read under the same
 * exclusive lock that authorizes the write, so an id from another event is
 * indistinguishable from an unknown one (S1).
 *
 * Every write in this file takes the lock order documented in
 * `lib/services/onboarding-task-lock.ts`, and any write that leaves a required
 * template in place runs the shared confirmed-speaker fan-out inside the same
 * transaction (C33) — a required task must never exist without reaching the
 * speakers it blocks, or `/admin/speakers` would report them Ready while they
 * have unfinished work they have not even been given.
 */
const taskSelect = {
  id: true,
  title: true,
  description: true,
  dueAt: true,
  required: true,
  formConfigId: true,
  sortOrder: true,
} as const;

const taskOrder = [{ sortOrder: "asc" as const }, { title: "asc" as const }, { id: "asc" as const }];

const SETTLED_TASK_STATUSES = ["COMPLETED", "WAIVED"] as const;

/** The event's own timezone decides what calendar day a deadline means. */
async function requireEventTimezone(tx: Prisma.TransactionClient, eventId: string): Promise<string> {
  const event = await tx.event.findUnique({ where: { id: eventId }, select: { timezone: true } });
  if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found.");
  return event.timezone;
}

/**
 * Resolve the linked form from the rows already locked in this transaction.
 * `undefined` leaves the stored link alone, `null` clears it, and an id that is
 * unknown or belongs to another event is refused with one indistinguishable
 * result.
 */
function resolveLinkedForm(
  requested: string | null | undefined,
  locked: Map<string, LockedTaskFormConfig>,
  eventId: string,
): string | null | undefined {
  if (requested === undefined) return undefined;
  if (requested === null) return null;
  const form = locked.get(requested);
  if (!form || form.eventId !== eventId) {
    throw new ApiError(404, "TASK_FORM_NOT_FOUND", "Form not found.", {
      formConfigId: ["Pick a form that belongs to this event."],
    });
  }
  return form.id;
}

function duplicateTitle(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function titleTakenError(): ApiError {
  return new ApiError(409, "TASK_TITLE_TAKEN", "Another task in this event already uses that title.", {
    title: ["This task title is already in use."],
  });
}

/** GET /api/admin/tasks — the event's checklist with due dates and progress. */
export const GET = handle(async () => {
  const ctx = await requireContext(["ADMIN"]);
  const [event, tasks, forms] = await Promise.all([
    prisma.event.findUnique({ where: { id: ctx.eventId }, select: { timezone: true } }),
    prisma.onboardingTask.findMany({
      where: { eventId: ctx.eventId },
      orderBy: taskOrder,
      take: OPERATOR_QUERY_LIMITS.onboardingTasks + 1,
      select: taskSelect,
    }),
    prisma.formConfig.findMany({
      where: { eventId: ctx.eventId },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: OPERATOR_QUERY_LIMITS.importForms + 1,
      select: { id: true, name: true },
    }),
  ]);
  if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found.");
  assertEventQueryBound(tasks, OPERATOR_QUERY_LIMITS.onboardingTasks, "onboarding tasks");
  assertEventQueryBound(forms, OPERATOR_QUERY_LIMITS.importForms, "forms");

  const views = await withAssignmentCounts(tasks, ctx.eventId, event.timezone);
  return ok({ tasks: views, forms, timezone: event.timezone });
});

/**
 * Assignment progress per template, read as two grouped counts rather than one
 * row per assignment so a large event does not materialize its whole checklist
 * cross-product to render a progress column.
 *
 * Both aggregations are keyed on the **projected** template ids, not on the
 * event. The projection above is capped at `OPERATOR_QUERY_LIMITS.onboardingTasks`,
 * so grouping by event would have let an oversized event return unbounded
 * groups behind an otherwise bounded read — the cap would hold on the rows the
 * caller sees while the work behind them grew without limit. Keying on the ids
 * ties the aggregation to the same bound, and a template outside the page is
 * not counted because it is not shown.
 */
async function withAssignmentCounts(
  tasks: { id: string; title: string; description: string | null; dueAt: Date | null; required: boolean; formConfigId: string | null; sortOrder: number }[],
  eventId: string,
  timeZone: string,
): Promise<OnboardingTaskView[]> {
  const taskIds = tasks.map((task) => task.id);
  // No templates means nothing to aggregate; skip both round trips rather than
  // issuing a pair of queries whose answer is known to be empty.
  const [assigned, settled] = taskIds.length === 0 ? [[], []] : await Promise.all([
    prisma.speakerTask.groupBy({
      by: ["taskId"],
      // `eventId` is retained alongside the id bound as a scope belt: the ids
      // already come from an event-scoped read, and this keeps that true even
      // if the projection is ever sourced differently.
      where: { taskId: { in: taskIds }, task: { eventId } },
      _count: { _all: true },
    }),
    prisma.speakerTask.groupBy({
      by: ["taskId"],
      where: { taskId: { in: taskIds }, task: { eventId }, status: { in: [...SETTLED_TASK_STATUSES] } },
      _count: { _all: true },
    }),
  ]);
  const assignedByTask = new Map(assigned.map((row) => [row.taskId, row._count._all]));
  const settledByTask = new Map(settled.map((row) => [row.taskId, row._count._all]));
  return tasks
    .map((task) =>
      serializeOnboardingTask(task, timeZone, {
        assigned: assignedByTask.get(task.id) ?? 0,
        settled: settledByTask.get(task.id) ?? 0,
      }),
    )
    .sort(compareOnboardingTasks);
}

/**
 * POST /api/admin/tasks — add a template to the active event.
 *
 * C33: a required template fans out to every confirmed speaker in the same
 * transaction that creates it. Either both happened or neither did, so there is
 * no window in which the task exists but nobody has it.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, onboardingTaskCreateSchema);

  try {
    const result = await prisma.$transaction(async (tx) => {
      await lockEventTaskFanOut(tx, ctx.eventId);
      const lockedForms = await lockFormConfigsForTaskWrite(tx, [input.formConfigId]);
      const formConfigId = resolveLinkedForm(input.formConfigId, lockedForms, ctx.eventId) ?? null;
      const timezone = await requireEventTimezone(tx, ctx.eventId);

      // Appending is what an organizer means by "add a task"; an explicit
      // sortOrder still wins so the list can be reordered later.
      const last = await tx.onboardingTask.findFirst({
        where: { eventId: ctx.eventId },
        orderBy: { sortOrder: "desc" },
        select: { sortOrder: true },
      });
      const required = input.required ?? true;
      const task = await tx.onboardingTask.create({
        data: {
          eventId: ctx.eventId,
          title: input.title,
          description: input.description ?? null,
          dueAt: taskDueAtFromDateKey(input.dueOn, timezone),
          required,
          formConfigId,
          sortOrder: input.sortOrder ?? (last ? last.sortOrder + 1 : 0),
        },
        select: taskSelect,
      });

      const fanOut = required
        ? await backfillConfirmedSpeakerTasks(tx, ctx.eventId)
        : { sessions: 0, assigned: 0 };
      return { task: serializeOnboardingTask(task, timezone), fanOut };
    });
    return ok({ task: result.task, assigned: result.fanOut.assigned, sessions: result.fanOut.sessions }, 201);
  } catch (error) {
    if (duplicateTitle(error)) throw titleTakenError();
    throw error;
  }
});

/**
 * PATCH /api/admin/tasks — edit a template of the active event.
 *
 * C33 again: if the row is required once the edit lands — whether it already
 * was or this edit made it so — the fan-out runs before the transaction
 * commits. Marking an existing optional task required is exactly the case that
 * would otherwise leave speakers falsely Ready.
 */
export const PATCH = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, onboardingTaskUpdateSchema);

  try {
    const result = await prisma.$transaction(async (tx) => {
      await lockEventTaskFanOut(tx, ctx.eventId);

      // The stored link has to be locked too — clearing or retargeting it takes
      // an FK lock on that FormConfig — but it is only knowable by reading the
      // task first. Read it unlocked, lock both candidate forms in sorted
      // order, then verify against the locked row below.
      const peeked = await peekTaskFormConfigId(tx, input.id);
      const lockedForms = await lockFormConfigsForTaskWrite(tx, [peeked?.formConfigId, input.formConfigId]);

      const locked = await lockOnboardingTaskForWrite(tx, input.id);
      const owned = requireEventOwnedRow(locked, ctx.eventId, "TASK_NOT_FOUND", "Task");
      if (owned.formConfigId !== (peeked?.formConfigId ?? null)) {
        // A concurrent organizer retargeted this task between the two reads, so
        // the form we hold is not the one this write would touch. Refusing is
        // the only safe answer: proceeding would take the FK lock out of order.
        throw new ApiError(409, "TASK_FORM_CHANGED", "This task's linked form changed while you were editing. Reload and try again.");
      }

      const formConfigId = resolveLinkedForm(input.formConfigId, lockedForms, ctx.eventId);
      const timezone = await requireEventTimezone(tx, ctx.eventId);
      const required = input.required ?? owned.required;

      const task = await tx.onboardingTask.update({
        where: { id: owned.id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.dueOn !== undefined ? { dueAt: taskDueAtFromDateKey(input.dueOn, timezone) } : {}),
          ...(input.required !== undefined ? { required: input.required } : {}),
          ...(formConfigId !== undefined ? { formConfigId } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        },
        select: taskSelect,
      });

      const fanOut = required
        ? await backfillConfirmedSpeakerTasks(tx, ctx.eventId)
        : { sessions: 0, assigned: 0 };
      return { task: serializeOnboardingTask(task, timezone), fanOut };
    });
    return ok({ task: result.task, assigned: result.fanOut.assigned, sessions: result.fanOut.sessions });
  } catch (error) {
    if (duplicateTitle(error)) throw titleTakenError();
    // The scoped preflight can be invalidated by a concurrent delete. Keep that
    // race indistinguishable from an unknown or cross-event task id.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      throw new ApiError(404, "TASK_NOT_FOUND", "Task not found.");
    }
    throw error;
  }
});

/**
 * DELETE /api/admin/tasks?taskId= — remove a template nobody has worked on.
 *
 * S15's philosophy one level down: `SpeakerTask` rows cascade from this row and
 * carry the speaker's form answers, artifact URL, and notes, so a template with
 * any speaker work on it is refused with a stable `TASK_HAS_RESPONSES` rather
 * than cascading that history away. Locking and re-reading the template before
 * counting keeps the cascade unreachable — a concurrent assignment's FK
 * key-share acquisition waits for this transaction and can only proceed after
 * it has either refused or deleted the row.
 */
export const DELETE = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const taskId = new URL(req.url).searchParams.get("taskId");
  if (!taskId) throw new ApiError(400, "MISSING_TASK", "taskId is required.");

  const task = await prisma.$transaction(async (tx) => {
    await lockEventTaskFanOut(tx, ctx.eventId);
    const peeked = await peekTaskFormConfigId(tx, taskId);
    await lockFormConfigsForTaskWrite(tx, [peeked?.formConfigId]);

    const locked = await lockOnboardingTaskForWrite(tx, taskId);
    const owned = requireEventOwnedRow(locked, ctx.eventId, "TASK_NOT_FOUND", "Task");
    if (owned.formConfigId !== (peeked?.formConfigId ?? null)) {
      throw new ApiError(409, "TASK_FORM_CHANGED", "This task's linked form changed while you were deleting it. Reload and try again.");
    }

    const started = await tx.speakerTask.count({ where: startedTaskAssignmentWhere(owned.id) });
    const decision = decideOnboardingTaskDeletion(started);
    if (!decision.allowed) {
      throw new ApiError(409, decision.code, decision.message, {
        taskId: ["Speaker answers and progress on this task are preserved."],
      });
    }

    const timezone = await requireEventTimezone(tx, ctx.eventId);
    const deleted = await tx.onboardingTask.delete({ where: { id: owned.id }, select: taskSelect });
    return serializeOnboardingTask(deleted, timezone);
  });

  return ok({ task });
});
