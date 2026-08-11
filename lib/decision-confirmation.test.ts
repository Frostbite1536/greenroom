import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decisionConfirmation,
  speakerTaskCount,
  type DecisionOutcome,
} from "@/lib/decision-confirmation";

const accepted = (over: Partial<DecisionOutcome> = {}): DecisionOutcome => ({
  decision: "ACCEPTED",
  sessionCreated: true,
  tasksAssigned: 4,
  hasSession: true,
  sessionScheduled: false,
  ...over,
});

test("the golden path names the session, the task count and the next step", () => {
  // Pinned verbatim: the e2e golden-path spec asserts this exact sentence.
  assert.equal(
    decisionConfirmation(accepted()),
    "Accepted. One confirmed session and 4 speaker onboarding tasks were created. The session still needs a schedule placement.",
  );
});

test("the task count is singular for exactly one task", () => {
  assert.equal(speakerTaskCount(1), "1 speaker onboarding task");
  assert.equal(speakerTaskCount(0), "0 speaker onboarding tasks");
  assert.equal(speakerTaskCount(2), "2 speaker onboarding tasks");
  assert.match(
    decisionConfirmation(accepted({ tasksAssigned: 1 })),
    /One confirmed session and 1 speaker onboarding task were created\./,
  );
});

test("a created session with no checklist never claims tasks were made", () => {
  const copy = decisionConfirmation(accepted({ tasksAssigned: 0 }));
  assert.match(copy, /One confirmed session was created\./);
  assert.match(copy, /No speaker onboarding tasks were added/);
  assert.doesNotMatch(copy, /tasks were created/);
});

test("re-accepting takes no credit for a session it did not create", () => {
  const toppedUp = decisionConfirmation(accepted({ sessionCreated: false, tasksAssigned: 2 }));
  assert.match(toppedUp, /Its confirmed session already existed/);
  assert.match(toppedUp, /2 speaker onboarding tasks were added/);
  assert.doesNotMatch(toppedUp, /were created/);

  const nothingNew = decisionConfirmation(accepted({ sessionCreated: false, tasksAssigned: 0 }));
  assert.match(nothingNew, /nothing new was created/);
});

test("an already-scheduled talk is not told it needs a placement", () => {
  const copy = decisionConfirmation(accepted({ sessionScheduled: true }));
  assert.match(copy, /already placed on the schedule\./);
  assert.doesNotMatch(copy, /still needs a schedule placement/);
});

test("the legacy no-session branch points at the conversion control", () => {
  const copy = decisionConfirmation(accepted({ hasSession: false, sessionCreated: false, tasksAssigned: 0 }));
  assert.match(copy, /No confirmed session exists yet/);
  assert.doesNotMatch(copy, /needs a schedule placement/);
});

test("maybe and decline each state plainly that nothing was created", () => {
  const maybe = decisionConfirmation({
    decision: "MAYBE",
    sessionCreated: false,
    tasksAssigned: 0,
    hasSession: false,
    sessionScheduled: false,
  });
  assert.match(maybe, /^Marked as maybe\./);
  assert.match(maybe, /No session and no speaker tasks were created/);
  assert.match(maybe, /stays in review/);

  const declined = decisionConfirmation({
    decision: "REJECTED",
    sessionCreated: false,
    tasksAssigned: 0,
    hasSession: false,
    sessionScheduled: false,
  });
  assert.match(declined, /^Declined\./);
  assert.match(declined, /No session was created/);
  assert.match(declined, /out of the programme/);
});

test("every branch is one or more complete sentences, never a bare verdict", () => {
  const branches: DecisionOutcome[] = [
    accepted(),
    accepted({ tasksAssigned: 0 }),
    accepted({ sessionCreated: false }),
    accepted({ sessionCreated: false, tasksAssigned: 0 }),
    accepted({ sessionScheduled: true }),
    accepted({ hasSession: false }),
    { decision: "MAYBE", sessionCreated: false, tasksAssigned: 0, hasSession: false, sessionScheduled: false },
    { decision: "REJECTED", sessionCreated: false, tasksAssigned: 0, hasSession: false, sessionScheduled: false },
  ];
  for (const branch of branches) {
    const copy = decisionConfirmation(branch);
    assert.ok(copy.endsWith("."), `not a sentence: ${copy}`);
    assert.ok(copy.length > "Accepted.".length, `too terse: ${copy}`);
  }
});
