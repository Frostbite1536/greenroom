import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canRequestWithdrawal,
  editSavedNotice,
  editScopeNotice,
  submissionActionLabel,
  submissionErrorMessage,
  submissionStatusView,
  withdrawalSuccessNotice,
  withdrawalUnavailableNotice,
} from "./submission-status";

const ALL = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "MAYBE", "ACCEPTED", "REJECTED", "WITHDRAWN"];

test("every status reads as plain English, never as a raw code", () => {
  for (const status of ALL) {
    const view = submissionStatusView(status);
    assert.ok(view.label.length > 0 && view.detail.length > 0, status);
    assert.doesNotMatch(view.label, /[A-Z]{2,}|_/, `label leaks a code: ${view.label}`);
    assert.doesNotMatch(view.detail, /\b[A-Z][A-Z_]{3,}\b/, `detail leaks a code: ${view.detail}`);
  }
  assert.equal(submissionStatusView("UNDER_REVIEW").label, "In review");
  const maybe = submissionStatusView("MAYBE");
  assert.equal(maybe.label, "Maybe");
  assert.match(maybe.detail, /still deciding/i);
  assert.equal(maybe.editable, true);
});

test("editability matches the backend contract: terminal outcomes are read-only", () => {
  for (const status of ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "MAYBE", "ACCEPTED"]) {
    assert.equal(submissionStatusView(status).editable, true, status);
  }
  for (const status of ["REJECTED", "WITHDRAWN"]) {
    assert.equal(submissionStatusView(status).editable, false, status);
  }
});

test("an unknown status degrades to neutral copy instead of crashing", () => {
  const view = submissionStatusView("SOMETHING_NEW");
  assert.equal(view.editable, false);
  assert.doesNotMatch(view.detail, /SOMETHING_NEW/);
});

test("error codes become sentences a speaker can act on", () => {
  const locked = submissionErrorMessage("SPEAKERS_LOCKED");
  assert.match(locked, /program team/);
  assert.doesNotMatch(locked, /SPEAKERS_LOCKED/);

  for (const code of ["UNAUTHENTICATED", "NOT_YOUR_SUBMISSION", "ABSTRACT_NOT_FOUND", "ABSTRACT_LOCKED", "FIELD_ERRORS", "TOO_MANY_SPEAKERS", "NO_PRIMARY_SPEAKER", "INVALID_CATEGORY", "NETWORK_ERROR"]) {
    const message = submissionErrorMessage(code);
    assert.doesNotMatch(message, /\b[A-Z][A-Z_]{3,}\b/, `${code} leaked into UI copy: ${message}`);
  }
});

test("an unknown code prefers the server's prose but never echoes a bare code", () => {
  assert.equal(submissionErrorMessage("WHATEVER", "The form is closed for new proposals."), "The form is closed for new proposals.");
  assert.doesNotMatch(submissionErrorMessage("WHATEVER", "SOME_CODE"), /SOME_CODE/);
  assert.doesNotMatch(submissionErrorMessage("WHATEVER"), /WHATEVER/);
});

test("edit-scope copy tells the truth about what an edit changes", () => {
  const beforeConversion = editScopeNotice(false);
  const afterConversion = editScopeNotice(true);
  assert.match(beforeConversion, /update your proposal directly/i);
  // Once a talk is scheduled the session drives the public listing, so the copy
  // must NOT promise the schedule changes (audit1#8).
  assert.match(afterConversion, /don't update the public schedule listing/i);
  assert.doesNotMatch(afterConversion, /\bwill update the (public|schedule)\b/i);
  for (const text of [beforeConversion, afterConversion]) {
    assert.doesNotMatch(text, /\b[A-Z][A-Z_]{3,}\b/);
  }
});

test("accepted-status copy no longer claims edits reach attendees", () => {
  const accepted = submissionStatusView("ACCEPTED");
  assert.equal(accepted.editable, true);
  assert.doesNotMatch(accepted.detail, /details attendees will see/i);
});

test("save confirmation preserves the proposal/session boundary", () => {
  assert.match(editSavedNotice(false), /updated proposal/i);
  assert.match(editSavedNotice(true), /public schedule listing has not changed/i);
  assert.doesNotMatch(editSavedNotice(true), /right away/i);
});

test("only pre-decision, unconverted proposals offer a withdrawal request", () => {
  for (const status of ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "MAYBE"]) {
    assert.equal(canRequestWithdrawal(status, false), true, status);
    assert.equal(canRequestWithdrawal(status, true), false, `${status} with a session`);
  }
  for (const status of ["ACCEPTED", "REJECTED", "WITHDRAWN", "UNKNOWN"]) {
    assert.equal(canRequestWithdrawal(status, false), false, status);
  }
  assert.match(withdrawalUnavailableNotice("ACCEPTED", false) ?? "", /program team/i);
  assert.match(withdrawalUnavailableNotice("SUBMITTED", true) ?? "", /program team/i);
  assert.equal(withdrawalUnavailableNotice("REJECTED", false), null);
});

test("withdrawal success and a concurrent acceptance refusal stay actionable", () => {
  assert.match(withdrawalSuccessNotice(), /withdrawn/i);
  assert.match(withdrawalSuccessNotice(), /no longer under consideration/i);
  const refusal = submissionErrorMessage("WITHDRAW_NOT_ALLOWED");
  assert.match(refusal, /program team/i);
  assert.doesNotMatch(refusal, /WITHDRAW_NOT_ALLOWED/);
});

test("save and withdrawal buttons only announce their own request", () => {
  assert.equal(submissionActionLabel("save", "save"), "Saving…");
  assert.equal(submissionActionLabel("save", "withdraw"), "Save changes");
  assert.equal(submissionActionLabel("withdraw", "withdraw"), "Withdrawing…");
  assert.equal(submissionActionLabel("withdraw", "save"), "Withdraw proposal");
});
