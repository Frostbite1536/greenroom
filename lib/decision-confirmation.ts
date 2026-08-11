/**
 * What a decision just did, in one sentence the organizer can act on.
 *
 * Accepting is the only decision that builds anything: `POST
 * /api/evaluations/decisions` provisions the confirmed Session and every
 * speaker's onboarding checklist inside one transaction, and reports both back
 * as `sessionCreated` and `tasksAssigned` (see the route's own doc comment).
 * The drawer used to answer all of that with the word "Accepted." — true, but
 * it hid the two records the click had just created and the one step still
 * outstanding, so an organizer had to go looking to find out whether the
 * product had done its job.
 *
 * This is a pure function over the decision response so the copy is unit
 * testable and cannot drift between the branches. It is deliberately honest
 * about every branch: re-accepting an abstract that already has a session
 * creates nothing, and an event with no onboarding checklist assigns no tasks.
 * Neither may be reported as if a session or a task had been created.
 */

export type DecisionOutcome = {
  decision: "ACCEPTED" | "MAYBE" | "REJECTED";
  /** `sessionCreated` from the response: true only when this click built it. */
  sessionCreated: boolean;
  /** `tasksAssigned` from the response: rows actually inserted, never a total. */
  tasksAssigned: number;
  /** Whether a confirmed session exists at all now (created or pre-existing). */
  hasSession: boolean;
  /** Whether that session already occupies a schedule slot. */
  sessionScheduled: boolean;
};

/** "1 speaker onboarding task" / "3 speaker onboarding tasks". */
export function speakerTaskCount(count: number): string {
  const n = Math.max(0, Math.trunc(count));
  return `${n} speaker onboarding task${n === 1 ? "" : "s"}`;
}

/**
 * The remaining step, stated as a step. A confirmed talk that is not on the
 * schedule is the golden path's next click, so it is named rather than implied.
 */
function placementClause(outcome: DecisionOutcome): string {
  if (!outcome.hasSession) return "";
  return outcome.sessionScheduled
    ? " The session is already placed on the schedule."
    : " The session still needs a schedule placement.";
}

function acceptedConfirmation(outcome: DecisionOutcome): string {
  if (!outcome.hasSession) {
    // Defensive: acceptance provisions a session, so this is the legacy
    // abstract the convert route exists for. Never claim a session was made.
    return "Accepted. No confirmed session exists yet — use “Create session” to add one.";
  }

  const tail = placementClause(outcome);

  if (outcome.sessionCreated) {
    return outcome.tasksAssigned > 0
      ? `Accepted. One confirmed session and ${speakerTaskCount(outcome.tasksAssigned)} were created.${tail}`
      : `Accepted. One confirmed session was created. No speaker onboarding tasks were added, because this event has no onboarding checklist yet.${tail}`;
  }

  // Re-accepting: the session was already there. Say so instead of taking
  // credit for it, but still report any checklist rows this click topped up.
  return outcome.tasksAssigned > 0
    ? `Accepted. Its confirmed session already existed, and ${speakerTaskCount(outcome.tasksAssigned)} were added.${tail}`
    : `Accepted. Its confirmed session and speaker onboarding tasks were already in place — nothing new was created.${tail}`;
}

export function decisionConfirmation(outcome: DecisionOutcome): string {
  switch (outcome.decision) {
    case "ACCEPTED":
      return acceptedConfirmation(outcome);
    case "MAYBE":
      // MAYBE provisions nothing by design (it carries no decision timestamp
      // and is refused once a confirmed session exists), so the confirmation's
      // job is to say that no talk was created and the proposal is still live.
      return "Marked as maybe. No session and no speaker tasks were created — the proposal stays in review and can be scored or decided again.";
    case "REJECTED":
      // The declined-with-a-live-talk case never reaches here: it raises the
      // programme-mismatch warning instead, which is a stronger surface than a
      // notice inside a drawer that is about to close.
      return "Declined. No session was created and this proposal is out of the program; it can still be accepted later if it should run after all.";
  }
}
