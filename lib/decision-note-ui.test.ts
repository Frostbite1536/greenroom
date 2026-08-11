import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDraftToNote,
  describeApplyAction,
  describeDraftFailure,
  describeDraftGrounding,
  isDraftResponseCurrent,
  type DraftSuggestion,
} from "./decision-note-ui";

/**
 * The no-overwrite rule is the assessment's one hard UX requirement, so it is
 * tested as a pure function rather than left to a component to remember.
 */

const suggestion = (over: Partial<DraftSuggestion> = {}): DraftSuggestion => ({
  draft: "Thank you for proposing this — the programme team enjoyed it.",
  commentsAvailable: 3,
  commentIndexesUsed: [0, 1, 2],
  ...over,
});

test("an empty note takes the draft immediately: there is nothing to lose", () => {
  for (const note of ["", "   ", "\n\t "]) {
    const outcome = applyDraftToNote({ note, draft: "Generated text.", confirmed: false });
    assert.deepEqual(outcome, { status: "applied", note: "Generated text." });
  }
});

test("a note the organizer wrote is NEVER replaced without an explicit confirmation", () => {
  const note = "I loved this one. Let's make room for it.";
  const first = applyDraftToNote({ note, draft: "Generated text.", confirmed: false });
  assert.deepEqual(first, { status: "needs-confirmation" });
  // The outcome carries no note at all, so a caller that ignored the status
  // still could not accidentally write over the organizer's paragraph.
  assert.equal("note" in first, false);

  const second = applyDraftToNote({ note, draft: "Generated text.", confirmed: true });
  assert.deepEqual(second, { status: "applied", note: "Generated text." });
});

test("even one character of organizer text is enough to require confirmation", () => {
  assert.deepEqual(applyDraftToNote({ note: "x", draft: "d", confirmed: false }), { status: "needs-confirmation" });
});

test("an empty draft applies nothing, so a blank suggestion cannot erase a note", () => {
  for (const draft of ["", "   "]) {
    assert.deepEqual(applyDraftToNote({ note: "My note.", draft, confirmed: true }), { status: "empty" });
    assert.deepEqual(applyDraftToNote({ note: "", draft, confirmed: true }), { status: "empty" });
  }
});

test("the applied note is the trimmed draft, and only the draft", () => {
  const outcome = applyDraftToNote({ note: "", draft: "  spaced out  ", confirmed: false });
  assert.deepEqual(outcome, { status: "applied", note: "spaced out" });
  // It never concatenates: appending to an existing note would be a third
  // behaviour nobody asked for, and would make "replace" a lie.
  const replaced = applyDraftToNote({ note: "Original.", draft: "New.", confirmed: true });
  assert.equal(replaced.status === "applied" && replaced.note, "New.");
  assert.equal(replaced.status === "applied" && replaced.note.includes("Original."), false);
});

test("the apply control says what the click will do", () => {
  assert.equal(describeApplyAction(""), "Use this note");
  assert.equal(describeApplyAction("   "), "Use this note");
  assert.equal(describeApplyAction("I wrote this."), "Replace my note");
});

test("the grounding names the comments actually used, not the ones that existed", () => {
  assert.equal(
    describeDraftGrounding(suggestion()),
    "Based on 3 reviewer comments, plus the proposal title and your decision.",
  );
  assert.equal(
    describeDraftGrounding(suggestion({ commentsAvailable: 1, commentIndexesUsed: [0] })),
    "Based on 1 reviewer comment, plus the proposal title and your decision.",
  );
  // Partial grounding is stated as partial: an organizer must be able to tell a
  // draft built from two of nine comments from one built from all nine.
  assert.equal(
    describeDraftGrounding(suggestion({ commentsAvailable: 9, commentIndexesUsed: [0, 3] })),
    "Based on 2 reviewer comments of 9, plus the proposal title and your decision.",
  );
});

test("no comments used is distinguished from no comments existing", () => {
  // Declined feedback: comments exist, none were sent.
  assert.match(
    describeDraftGrounding(suggestion({ commentsAvailable: 4, commentIndexesUsed: [] })),
    /no reviewer comments were included/,
  );
  // Nothing to send in the first place.
  assert.match(
    describeDraftGrounding(suggestion({ commentsAvailable: 0, commentIndexesUsed: [] })),
    /this proposal has no reviewer comments/,
  );
  // Neither claims a grounding it does not have.
  for (const available of [0, 4]) {
    assert.doesNotMatch(
      describeDraftGrounding(suggestion({ commentsAvailable: available, commentIndexesUsed: [] })),
      /Based on/,
    );
  }
});

test("a response is current only when nothing about the request has moved on", () => {
  const token = { seq: 3, abstractId: "abstract-a", includeFeedback: true };
  assert.equal(isDraftResponseCurrent(token, { ...token }), true);

  // The counter is bumped by every generation and by every change that
  // invalidates one, so a stale response fails on it alone.
  assert.equal(isDraftResponseCurrent(token, { ...token, seq: 4 }), false);
  // Belt and braces: the selection is checked independently, so a response
  // could not install under another proposal even if a counter were reused.
  assert.equal(isDraftResponseCurrent(token, { ...token, abstractId: "abstract-b" }), false);
  assert.equal(isDraftResponseCurrent(token, { ...token, includeFeedback: false }), false);
  assert.equal(
    isDraftResponseCurrent(token, { seq: 4, abstractId: "abstract-b", includeFeedback: false }),
    false,
  );
});

test("the stale-response race: A is fired, B is selected, A resolves late and installs nothing", () => {
  // The exact sequence the panel runs, with the counter it keeps.
  let seq = 0;
  let selectedId = "abstract-a";
  const includeFeedback = true;
  const installed = [] as string[];

  // 1. The organizer asks for a draft of proposal A.
  seq += 1;
  const requestA = { seq, abstractId: selectedId, includeFeedback };

  // 2. Before it returns they switch to proposal B. The panel's selection
  //    handler calls clearSuggestion(), which bumps the counter.
  selectedId = "abstract-b";
  seq += 1;

  // 3. A's response finally arrives.
  if (isDraftResponseCurrent(requestA, { seq, abstractId: selectedId, includeFeedback })) {
    installed.push("A's draft");
  }
  // `.length`, not `deepEqual(installed, [])`: node's assert narrows `actual` to
  // the type of `expected`, which would freeze this array as `never[]`.
  assert.equal(installed.length, 0, "a draft for the abandoned proposal must not install under the new one");

  // Non-vacuity: the request the organizer is actually waiting for still installs.
  seq += 1;
  const requestB = { seq, abstractId: selectedId, includeFeedback };
  if (isDraftResponseCurrent(requestB, { seq, abstractId: selectedId, includeFeedback })) {
    installed.push("B's draft");
  }
  assert.deepEqual(installed, ["B's draft"], "the current request must still be installable");
});

test("a failure message is the server's, and the fallback never implies the note was lost", () => {
  assert.equal(describeDraftFailure("Drafting is not configured for this deployment."), "Drafting is not configured for this deployment.");
  for (const empty of [undefined, null, "", "   "]) {
    const copy = describeDraftFailure(empty);
    assert.match(copy, /Your note is untouched/);
    assert.match(copy, /write it yourself/i);
  }
});
