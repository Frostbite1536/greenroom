import { zonedParts, zonedToUtcIso } from "@/lib/tz";

/**
 * The shared shape of an onboarding-task template as the operator surfaces see
 * it, and the one place a due date crosses between "calendar day the organizer
 * typed" and "instant the database stores".
 *
 * A deadline means "by the end of that day, where the event is". Storing 23:59
 * event-local — the convention `lib/demo/seed.ts` already uses — keeps a task
 * due on the 12th from rendering as the 11th for a speaker in a western zone,
 * and keeps the round trip through a `<input type="date">` stable: the day the
 * organizer picks is the day they get back.
 */
export const TASK_DUE_TIME = "23:59";

export type OnboardingTaskRow = {
  id: string;
  title: string;
  description: string | null;
  dueAt: Date | string | null;
  required: boolean;
  formConfigId: string | null;
  sortOrder: number;
};

export type OnboardingTaskView = {
  id: string;
  title: string;
  description: string | null;
  /** Stored instant, for rendering through `formatEventDateTime`. */
  dueAt: string | null;
  /** Event-local `YYYY-MM-DD`, for round-tripping a date input. */
  dueOn: string | null;
  required: boolean;
  formConfigId: string | null;
  sortOrder: number;
  /** Speakers currently holding this task. */
  assignedCount: number;
  /** Of those, how many are completed or organizer-waived. */
  settledCount: number;
};

/** Event-local calendar day → the instant that day ends in the event's zone. */
export function taskDueAtFromDateKey(dueOn: string | null | undefined, timeZone: string): Date | null {
  if (!dueOn) return null;
  return new Date(zonedToUtcIso(dueOn, TASK_DUE_TIME, timeZone));
}

/** Stored instant → the event-local calendar day an organizer authored. */
export function taskDueOnFromInstant(dueAt: Date | string | null | undefined, timeZone: string): string | null {
  if (!dueAt) return null;
  const iso = dueAt instanceof Date ? dueAt.toISOString() : new Date(dueAt).toISOString();
  return zonedParts(iso, timeZone).dateKey;
}

export function serializeOnboardingTask(
  row: OnboardingTaskRow,
  timeZone: string,
  counts?: { assigned?: number; settled?: number },
): OnboardingTaskView {
  const dueAt = row.dueAt === null ? null : row.dueAt instanceof Date ? row.dueAt.toISOString() : row.dueAt;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    dueAt,
    dueOn: taskDueOnFromInstant(dueAt, timeZone),
    required: row.required,
    formConfigId: row.formConfigId,
    sortOrder: row.sortOrder,
    assignedCount: counts?.assigned ?? 0,
    settledCount: counts?.settled ?? 0,
  };
}

/** Stable operator ordering: the organizer's own order, then title, then id. */
export function compareOnboardingTasks(a: OnboardingTaskView, b: OnboardingTaskView): number {
  return a.sortOrder - b.sortOrder || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}
