/**
 * The confirmation for a directly authored talk, branch by branch.
 *
 * Same bar as `decision-confirmation.test.ts`: every branch must name what was
 * actually created and must not claim anything that was not. The failure this
 * guards against is the cheerful lie — "created with speakers" on a sponsor slot
 * that has none, or "onboarding tasks were added" on an event with no checklist.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  guaranteedSessionConfirmation,
  speakerCount,
  type GuaranteedSessionOutcome,
} from "@/lib/guaranteed-session-confirmation";

const created = (over: Partial<GuaranteedSessionOutcome> = {}): GuaranteedSessionOutcome => ({
  title: "Opening keynote",
  speakersAdded: 2,
  tasksAssigned: 6,
  durationMinutes: 45,
  ...over,
});

test("the confirmation names the talk that was created", () => {
  const copy = guaranteedSessionConfirmation(created());
  // The repo convention: name what the click built, do not just say "Created."
  assert.match(copy, /Created “Opening keynote”/);
  assert.match(copy, /45-minute talk/);
  assert.match(copy, /no source proposal/);
  assert.match(copy, /2 speakers and 6 speaker onboarding tasks were added\./);
});

test("both remaining steps are named, because neither happened", () => {
  const copy = guaranteedSessionConfirmation(created());
  assert.match(copy, /It is a draft: publish it to announce it/);
  assert.match(copy, /place it on the schedule/);
});

test("a sponsor slot with nobody on it never claims a speaker", () => {
  const copy = guaranteedSessionConfirmation(created({ speakersAdded: 0, tasksAssigned: 0 }));
  assert.match(copy, /No speakers are on it yet/);
  assert.match(copy, /add them from the speaker roster/);
  // Neither a speaker nor a task may be reported as created.
  assert.doesNotMatch(copy, /were added/);
  assert.doesNotMatch(copy, /onboarding task/);
});

test("an event with no onboarding checklist is told so, not told zero tasks", () => {
  const copy = guaranteedSessionConfirmation(created({ speakersAdded: 1, tasksAssigned: 0 }));
  assert.match(copy, /1 speaker was added\./);
  assert.match(copy, /No speaker onboarding tasks were created, because this event has no onboarding checklist yet\./);
});

test("singular and plural agree in every counted branch", () => {
  assert.equal(speakerCount(0), "0 speakers");
  assert.equal(speakerCount(1), "1 speaker");
  assert.equal(speakerCount(2), "2 speakers");
  // The lone-speaker-no-tasks branch is the one that would read "1 speaker were
  // added" if the verb were hard-coded plural.
  assert.match(guaranteedSessionConfirmation(created({ speakersAdded: 1, tasksAssigned: 0 })), /1 speaker was added/);
  assert.match(guaranteedSessionConfirmation(created({ speakersAdded: 2, tasksAssigned: 0 })), /2 speakers were added/);
  // Joined by "and", a two-item list is plural however small each count is.
  assert.match(
    guaranteedSessionConfirmation(created({ speakersAdded: 1, tasksAssigned: 1 })),
    /1 speaker and 1 speaker onboarding task were added/,
  );
});

test("negative and fractional counts cannot leak into the copy", () => {
  const copy = guaranteedSessionConfirmation(
    created({ speakersAdded: -3, tasksAssigned: -1, durationMinutes: 45.9 }),
  );
  assert.doesNotMatch(copy, /-\d/);
  assert.doesNotMatch(copy, /\d\.\d/);
  assert.match(copy, /45-minute/);
  // A negative speaker count is the no-speakers branch, not "-3 speakers".
  assert.match(copy, /No speakers are on it yet/);
});

test("every branch is a real sentence, not a bare acknowledgement", () => {
  for (const outcome of [
    created(),
    created({ speakersAdded: 0, tasksAssigned: 0 }),
    created({ speakersAdded: 1, tasksAssigned: 0 }),
    created({ tasksAssigned: 0 }),
  ]) {
    const copy = guaranteedSessionConfirmation(outcome);
    assert.ok(copy.length > "Created.".length * 4, `too terse: ${copy}`);
    assert.match(copy, /^Created “/);
    assert.ok(copy.endsWith("."), `must end in a full stop: ${copy}`);
  }
});

test("the stored title is what is named, whatever it contains", () => {
  // The route reads the title back off the created row rather than echoing the
  // request, so a trimmed or truncated title is the one the organizer is shown.
  assert.match(
    guaranteedSessionConfirmation(created({ title: "Keynote: “quotes” & <angles>" })),
    /Created “Keynote: “quotes” & <angles>”/,
  );
});
