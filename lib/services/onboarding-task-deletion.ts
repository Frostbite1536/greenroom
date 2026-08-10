import { Prisma } from "@prisma/client";

/**
 * Template removal policy, kept separate from persistence so its user-facing
 * safety contract stays easy to test. The route supplies this decision only
 * after it has locked the template and re-read its assignments in the same
 * transaction.
 *
 * `OnboardingTask` owns its `SpeakerTask` rows with `onDelete: Cascade`, and a
 * `SpeakerTask` carries the speaker's form answers, uploaded artifact URL, and
 * notes. Deleting a template that anyone has worked on would therefore destroy
 * real speaker history silently, which is exactly what S15 refused to do for
 * forms. So the rule is the same one, one level down: a template nobody has
 * touched may be removed, and a template with any speaker work on it is
 * refused with a stable code and kept intact. There is no `archived` column on
 * this model, so "archive instead" is deliberately not offered here — an
 * organizer who no longer needs a task makes it optional.
 */
export type OnboardingTaskDeletionDecision =
  | { allowed: true }
  | { allowed: false; code: "TASK_HAS_RESPONSES"; message: string };

export function decideOnboardingTaskDeletion(startedAssignments: number): OnboardingTaskDeletionDecision {
  if (startedAssignments > 0) {
    return {
      allowed: false,
      code: "TASK_HAS_RESPONSES",
      message:
        "Speakers have already worked on this task, so their answers and progress are kept and the task cannot be deleted. Edit it, or make it optional instead.",
    };
  }
  return { allowed: true };
}

/**
 * What counts as "a speaker has already worked on this".
 *
 * Every column a speaker can write must be listed. `status` alone is not
 * enough: a task form saves partial answers into `responses` while the
 * assignment is still `TODO`, so a `status`-only predicate would cascade a
 * half-filled hotel form away without ever refusing. `responses` is a nullable
 * Json column, so it needs `Prisma.DbNull` rather than a bare `null`.
 */
export function startedTaskAssignmentWhere(taskId: string): Prisma.SpeakerTaskWhereInput {
  return {
    taskId,
    OR: [
      { status: { not: "TODO" } },
      { responses: { not: Prisma.DbNull } },
      { artifactUrl: { not: null } },
      { notes: { not: null } },
      { completedAt: { not: null } },
    ],
  };
}
