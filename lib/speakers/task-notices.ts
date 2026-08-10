/**
 * What to tell an organizer after a template write, given what actually
 * happened on the server.
 *
 * Pure so the copy is unit-tested rather than eyeballed: this sentence is the
 * only feedback an organizer gets about whether speakers can now see the task,
 * and it is easy to write one that is quietly false.
 *
 * Two facts have to be respected, and each has already been got wrong once:
 *
 *  1. An OPTIONAL template deliberately skips the fan-out, so it reports
 *     `assigned: 0` while nobody holds it. That is the opposite of a required
 *     template reporting `assigned: 0`, which means everyone already had it.
 *     Keying the sentence on the count alone tells an organizer their speakers
 *     can see a task that was never assigned to anyone.
 *  2. The count is the whole reconciliation, not this task's share. The
 *     backfill reconciles every template in the checklist, so a create can
 *     return rows belonging to other tasks that were previously missing.
 *     Claiming "assigned it to N" attributes those to the task just written.
 */
export type TaskWriteOutcome = {
  /** The past-tense verb for the write itself, e.g. "Added" or "Saved". */
  verb: string;
  title: string;
  /** Whether the stored template is required *after* this write. */
  required: boolean;
  /** Assignments the fan-out actually created, across the whole checklist. */
  assigned: number;
};

export function taskFanOutNotice({ verb, title, required, assigned }: TaskWriteOutcome): string {
  const subject = `${verb} “${title}”`;

  if (!required) {
    // No fan-out ran. Say so, and say how it would reach anyone, so the next
    // step is obvious rather than a silent gap.
    return `${subject}. Optional tasks are not assigned automatically — mark it required, or use “Assign checklist to all confirmed speakers”, to give it to speakers.`;
  }

  if (assigned === 0) {
    return `${subject}. Every confirmed speaker already has it.`;
  }

  return `${subject} and assigned ${assigned} missing task${assigned === 1 ? "" : "s"} across the checklist.`;
}

/**
 * The same honesty rule for the bulk action. An event with no confirmed
 * sessions has nobody to assign to, so "everyone already has the checklist" is
 * vacuously true and reads as reassurance when it should read as "there is
 * nobody here yet".
 */
export function bulkAssignNotice(assigned: number, sessions: number): string {
  if (sessions === 0) {
    return "No confirmed sessions yet, so there is nobody to assign the checklist to. Accept a proposal first.";
  }
  if (assigned === 0) {
    return `Every speaker across ${sessions} confirmed session${sessions === 1 ? "" : "s"} already has the full checklist.`;
  }
  return `Assigned ${assigned} missing task${assigned === 1 ? "" : "s"} across ${sessions} confirmed session${sessions === 1 ? "" : "s"}.`;
}
