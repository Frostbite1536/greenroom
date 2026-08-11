/**
 * What authoring a talk directly just created, in one sentence the organizer
 * can act on.
 *
 * The repo convention this follows is `lib/decision-confirmation.ts`: accepting
 * a proposal names the two records the click built and the one step still
 * outstanding, rather than answering with the word "Accepted." and leaving the
 * organizer to go looking. `POST /api/agenda/sessions` builds the same kinds of
 * record — a `Session`, its `SessionSpeaker` rows, and every speaker's
 * onboarding checklist — so its confirmation owes the same accounting.
 *
 * Pure over the response, for the same reason that module is: the copy is unit
 * testable and cannot drift between branches. And honest in every branch — a
 * sponsor slot created with nobody on it must not claim a speaker, and an event
 * with no onboarding checklist must not claim a task.
 *
 * The one thing this always says, which acceptance never has to: the talk is a
 * DRAFT. Creating and announcing are separate acts here, and an organizer who
 * assumed the keynote they just typed was live would find out from an attendee.
 */

import { speakerTaskCount } from "@/lib/decision-confirmation";

export type GuaranteedSessionOutcome = {
  /** The stored title, read back from the created row — never the typed input. */
  title: string;
  /** `SessionSpeaker` rows written by this request. */
  speakersAdded: number;
  /** `tasksAssigned` from the response: rows actually inserted, never a total. */
  tasksAssigned: number;
  durationMinutes: number;
};

/** "1 speaker" / "3 speakers". */
export function speakerCount(count: number): string {
  const n = Math.max(0, Math.trunc(count));
  return `${n} speaker${n === 1 ? "" : "s"}`;
}

/**
 * What was built, beyond the talk itself. A sponsor slot with no line-up yet is
 * a real and expected shape, so "no speakers" is stated as the deliberate thing
 * it is rather than reported as a count of zero.
 */
function builtClause(outcome: GuaranteedSessionOutcome): string {
  // Clamped before the branch, not just inside `speakerCount`. Branching on the
  // raw field let a nonsense negative fall through to the "were added" arm and
  // announce "0 speakers were added" — a count no reader can act on.
  const speakers = Math.max(0, Math.trunc(outcome.speakersAdded));
  if (speakers === 0) {
    return " No speakers are on it yet — add them from the speaker roster when the line-up is settled.";
  }
  // A two-item list is plural however few each item counts, but a lone speaker
  // is not: "1 speaker were added" is the sentence this branch exists to avoid.
  const wasWere = speakers === 1 ? "was" : "were";
  return outcome.tasksAssigned > 0
    ? ` ${speakerCount(speakers)} and ${speakerTaskCount(outcome.tasksAssigned)} were added.`
    : ` ${speakerCount(speakers)} ${wasWere} added. No speaker onboarding tasks were created, because this event has no onboarding checklist yet.`;
}

export function guaranteedSessionConfirmation(outcome: GuaranteedSessionOutcome): string {
  const minutes = Math.max(0, Math.trunc(outcome.durationMinutes));
  return (
    `Created “${outcome.title}”, a ${minutes}-minute talk with no source proposal.`
    + builtClause(outcome)
    // Both remaining steps, in the order an organizer takes them.
    + " It is a draft: publish it to announce it, and place it on the schedule to give it a room and a time."
  );
}
