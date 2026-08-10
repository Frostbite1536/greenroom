import assert from "node:assert/strict";
import test from "node:test";
import {
  closeDateEditRefusal,
  EDIT_WINDOW_CLOSED,
  EDITABLE_STATUSES,
  speakerEditRefusal,
  WITHDRAWABLE_STATUSES,
  isAbstractSpeaker,
  isEditableStatus,
  lockReasonFor,
  mergeAnswers,
  rosterChanged,
  speakerSubmissionPatchSchema,
  WITHDRAWAL_OPEN_ASSIGNMENT_STATUSES,
  withdrawRefusal,
} from "@/lib/services/speaker-edit";
import {
  validateSubmission,
  validateSubmissionContent,
  validateSubmissionWindow,
  type FormSpec,
} from "@/lib/services/form-validation";

// --- status rules -----------------------------------------------------------

test("draft, review, maybe, and accepted abstracts are editable", () => {
  for (const status of ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "MAYBE", "ACCEPTED"] as const) {
    assert.equal(isEditableStatus(status), true, status);
    assert.equal(lockReasonFor(status), null, status);
  }
});

test("rejected and withdrawn abstracts are locked with a plain-language reason", () => {
  for (const status of ["REJECTED", "WITHDRAWN"] as const) {
    assert.equal(isEditableStatus(status), false, status);
    const reason = lockReasonFor(status);
    assert.ok(reason && reason.length > 0, status);
    assert.ok(!/[A-Z_]{4,}/.test(reason), "lock reason must not leak an error code");
  }
});

test("the editable set includes the non-final MAYBE review state", () => {
  assert.deepEqual([...EDITABLE_STATUSES], ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "MAYBE", "ACCEPTED"]);
});

// --- CFP-16 close-date edit lock -------------------------------------------

const CLOSED_AT = new Date("2026-03-01T00:00:00.000Z");
const BEFORE_CLOSE = new Date("2026-02-28T23:59:59.000Z");
const AFTER_CLOSE = new Date("2026-03-01T00:00:01.000Z");

test("after the close date, every non-accepted status is refused with one stable code", () => {
  for (const status of ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "MAYBE"] as const) {
    const refusal = closeDateEditRefusal(status, CLOSED_AT, AFTER_CLOSE);
    assert.ok(refusal, status);
    assert.equal(refusal.code, EDIT_WINDOW_CLOSED, status);
    assert.ok(!/[A-Z_]{4,}/.test(refusal.message), "refusal copy must not leak an error code");
    assert.ok(refusal.message.length > 20, status);
  }
});

test("an accepted speaker keeps editing after the close date (deliberate carve-out)", () => {
  assert.equal(closeDateEditRefusal("ACCEPTED", CLOSED_AT, AFTER_CLOSE), null);
  assert.equal(speakerEditRefusal("ACCEPTED", CLOSED_AT, AFTER_CLOSE), null);
});

test("the close date is inclusive at the boundary and open before it", () => {
  assert.equal(closeDateEditRefusal("SUBMITTED", CLOSED_AT, BEFORE_CLOSE), null);
  assert.equal(closeDateEditRefusal("SUBMITTED", CLOSED_AT, CLOSED_AT)?.code, EDIT_WINDOW_CLOSED);
});

test("a form with no close date never locks edits", () => {
  for (const status of ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "MAYBE", "ACCEPTED"] as const) {
    assert.equal(closeDateEditRefusal(status, null, AFTER_CLOSE), null, status);
  }
});

test("the close-date lock matches the public window gate at the same instant", () => {
  // Both paths must agree that `now >= closesAt` is closed, so a speaker and an
  // anonymous submitter are never told different things about the same form.
  const spec: FormSpec = {
    published: true,
    opensAt: null,
    closesAt: CLOSED_AT,
    minSpeakers: 1,
    maxSpeakers: 4,
    maxBioLength: 500,
    fields: [],
  };
  assert.equal(validateSubmissionWindow(spec, BEFORE_CLOSE), null);
  assert.equal(closeDateEditRefusal("SUBMITTED", CLOSED_AT, BEFORE_CLOSE), null);
  assert.equal(validateSubmissionWindow(spec, AFTER_CLOSE)?.code, "FORM_CLOSED");
  assert.equal(closeDateEditRefusal("SUBMITTED", CLOSED_AT, AFTER_CLOSE)?.code, EDIT_WINDOW_CLOSED);
});

test("a terminal status is still reported as the status lock, not the closed window", () => {
  // Refusal order matters: a withdrawn proposal must keep saying it was
  // withdrawn even when the form also happens to be closed.
  for (const status of ["REJECTED", "WITHDRAWN"] as const) {
    const refusal = speakerEditRefusal(status, CLOSED_AT, AFTER_CLOSE);
    assert.equal(refusal?.code, "ABSTRACT_LOCKED", status);
    assert.equal(refusal?.message, lockReasonFor(status), status);
  }
});

test("withdrawal rules are untouched by the close date (a speaker is never trapped)", () => {
  // `withdrawRefusal` takes no clock and no form: closing the CFP must not make
  // a proposal impossible to pull.
  for (const status of ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "MAYBE"] as const) {
    assert.equal(withdrawRefusal(status, false), null, status);
  }
  assert.equal(withdrawRefusal("ACCEPTED", false)?.code, "WITHDRAW_NOT_ALLOWED");
});

// --- authorization ----------------------------------------------------------

test("a listed speaker is authorized, including a non-primary co-speaker", () => {
  const speakers = [
    { userId: "user-primary", isPrimary: true },
    { userId: "user-co", isPrimary: false },
  ];
  assert.equal(isAbstractSpeaker("user-primary", speakers), true);
  assert.equal(isAbstractSpeaker("user-co", speakers), true);
});

test("a user who is not on the abstract is refused", () => {
  assert.equal(isAbstractSpeaker("stranger", [{ userId: "user-primary" }]), false);
  assert.equal(isAbstractSpeaker("user-primary", []), false);
});

// --- roster lock ------------------------------------------------------------

const roster = [
  { email: "primary@example.test", isPrimary: true },
  { email: "co@example.test", isPrimary: false },
];

test("resending the same roster is not a change (order and case ignored)", () => {
  assert.equal(
    rosterChanged(roster, [
      { email: "CO@example.test", name: "Co", isPrimary: false },
      { email: "Primary@example.test", name: "Primary", isPrimary: true },
    ]),
    false,
  );
});

test("adding, removing, or re-pointing the primary counts as a roster change", () => {
  const added = [...roster, { email: "third@example.test", isPrimary: false }];
  assert.equal(rosterChanged(roster, added.map((s) => ({ ...s, name: "x" }))), true);
  assert.equal(rosterChanged(roster, [{ email: "primary@example.test", name: "P", isPrimary: true }]), true);
  assert.equal(
    rosterChanged(roster, [
      { email: "primary@example.test", name: "P", isPrimary: false },
      { email: "co@example.test", name: "C", isPrimary: true },
    ]),
    true,
  );
});

test("renaming a speaker is not a roster change", () => {
  assert.equal(
    rosterChanged(roster, [
      { email: "primary@example.test", name: "New Legal Name", isPrimary: true },
      { email: "co@example.test", name: "Also Renamed", isPrimary: false },
    ]),
    false,
  );
});

// --- answer merge -----------------------------------------------------------

const knownKeys = new Set(["title_note", "bio", "topics"]);

test("mergeAnswers keeps untouched stored answers", () => {
  const merged = mergeAnswers({ title_note: "kept", bio: "old" }, { bio: "new" }, knownKeys);
  assert.deepEqual(merged, { title_note: "kept", bio: "new" });
});

test("mergeAnswers ignores unknown keys from both sides", () => {
  const merged = mergeAnswers({ stale_field: "x", bio: "old" }, { ghost: "y" }, knownKeys);
  assert.deepEqual(merged, { bio: "old" });
});

test("mergeAnswers treats an explicit null as clearing the answer", () => {
  assert.deepEqual(mergeAnswers({ bio: "old" }, { bio: null }, knownKeys), { bio: null });
});

test("mergeAnswers with no patch returns the stored answers unchanged", () => {
  assert.deepEqual(mergeAnswers({ bio: "old" }, undefined, knownKeys), { bio: "old" });
});

// --- INV-FORM-001 reuse: content rules without the window gate ---------------

const closedForm: FormSpec = {
  published: true,
  opensAt: new Date("2026-01-01T00:00:00.000Z"),
  closesAt: new Date("2026-02-01T00:00:00.000Z"),
  minSpeakers: 1,
  maxSpeakers: 2,
  maxBioLength: 20,
  fields: [
    { key: "title_note", label: "Talk note", type: "SHORT_TEXT", required: true },
    { key: "bio", label: "Speaker bio", type: "LONG_TEXT", required: false },
  ],
};
const afterClose = new Date("2026-06-01T00:00:00.000Z");
const validAnswers = { speakerCount: 1, answers: { title_note: "ok" } };

test("public submission after the window closes is still refused", () => {
  assert.equal(validateSubmission(closedForm, validAnswers, afterClose)?.code, "FORM_CLOSED");
  assert.equal(validateSubmissionWindow(closedForm, afterClose)?.code, "FORM_CLOSED");
});

test("a speaker edit after the window closes passes content validation", () => {
  // The whole point of R1: acceptance happens long after the CFP closes.
  assert.equal(validateSubmissionContent(closedForm, validAnswers), null);
});

test("content rules still apply to an edit: required fields", () => {
  const error = validateSubmissionContent(closedForm, { speakerCount: 1, answers: { title_note: "" } });
  assert.equal(error?.code, "FIELD_ERRORS");
  assert.ok(error?.fieldErrors?.title_note);
});

test("content rules still apply to an edit: bio length and speaker counts", () => {
  const longBio = validateSubmissionContent(closedForm, {
    speakerCount: 1,
    answers: { title_note: "ok", bio: "x".repeat(21) },
  });
  assert.equal(longBio?.code, "FIELD_ERRORS");
  assert.ok(longBio?.fieldErrors?.bio);

  const tooMany = validateSubmissionContent(closedForm, { speakerCount: 3, answers: { title_note: "ok" } });
  assert.equal(tooMany?.code, "TOO_MANY_SPEAKERS");
});

test("validateSubmission is still window-then-content for the public path", () => {
  const openNow = new Date("2026-01-15T00:00:00.000Z");
  assert.equal(validateSubmission(closedForm, validAnswers, openNow), null);
  assert.equal(
    validateSubmission(closedForm, { speakerCount: 1, answers: {} }, openNow)?.code,
    "FIELD_ERRORS",
  );
});

// --- patch schema -----------------------------------------------------------

test("patch schema accepts a single-field edit and rejects an empty body", () => {
  assert.equal(speakerSubmissionPatchSchema.safeParse({ title: "A new title" }).success, true);
  assert.equal(speakerSubmissionPatchSchema.safeParse({}).success, false);
});

test("patch schema enforces the same field limits as public submission", () => {
  assert.equal(speakerSubmissionPatchSchema.safeParse({ title: "ab" }).success, false);
  assert.equal(speakerSubmissionPatchSchema.safeParse({ durationMinutes: 4 }).success, false);
  assert.equal(speakerSubmissionPatchSchema.safeParse({ durationMinutes: 45 }).success, true);
});

test("patch schema allows clearing nullable fields but not the title", () => {
  assert.equal(speakerSubmissionPatchSchema.safeParse({ abstract: null }).success, true);
  assert.equal(speakerSubmissionPatchSchema.safeParse({ categoryId: null }).success, true);
  assert.equal(speakerSubmissionPatchSchema.safeParse({ title: null }).success, false);
});

test("patch schema cannot smuggle a status other than WITHDRAWN, or a form change", () => {
  // WITHDRAWN is the one transition a speaker owns (W1); everything else here
  // must be stripped or refused.
  for (const status of ["ACCEPTED", "REJECTED", "UNDER_REVIEW", "SUBMITTED", "DRAFT"]) {
    assert.equal(
      speakerSubmissionPatchSchema.safeParse({ status }).success,
      false,
      `status ${status} must be refused`,
    );
  }
  const parsed = speakerSubmissionPatchSchema.parse({
    title: "Legit edit",
    submittedAt: "2020-01-01T00:00:00.000Z",
    decidedAt: "2020-01-01T00:00:00.000Z",
    formConfigId: "other-form",
    abstractId: "other-abstract",
  });
  assert.deepEqual(Object.keys(parsed), ["title"]);
});

// --- W1: self-withdraw ------------------------------------------------------

test("withdraw must be sent on its own, not bundled with content edits", () => {
  assert.equal(speakerSubmissionPatchSchema.safeParse({ status: "WITHDRAWN" }).success, true);
  const bundled = speakerSubmissionPatchSchema.safeParse({
    status: "WITHDRAWN",
    title: "Sneaky rename on the way out",
  });
  assert.equal(bundled.success, false);
});

test("a speaker may withdraw before a decision is made", () => {
  for (const status of WITHDRAWABLE_STATUSES) {
    assert.equal(withdrawRefusal(status, false), null, status);
  }
});

test("withdrawal declines only still-open review assignments", () => {
  assert.deepEqual(WITHDRAWAL_OPEN_ASSIGNMENT_STATUSES, ["ASSIGNED", "IN_PROGRESS"]);
});

test("an accepted talk cannot be self-withdrawn - it is the programme team's to remove", () => {
  const refusal = withdrawRefusal("ACCEPTED", false);
  assert.equal(refusal?.code, "WITHDRAW_NOT_ALLOWED");
  assert.ok(refusal && !/[A-Z_]{4,}/.test(refusal.message), "message must be plain language");
});

test("a converted abstract cannot be self-withdrawn even if its status drifted", () => {
  // Belt and braces: a confirmed Session must never vanish from the programme
  // because of a portal click (INV-DOMAIN-001).
  for (const status of WITHDRAWABLE_STATUSES) {
    assert.equal(withdrawRefusal(status, true)?.code, "WITHDRAW_NOT_ALLOWED", status);
  }
});

test("withdrawing an already-terminal abstract reports the lock, not the withdraw rule", () => {
  assert.equal(withdrawRefusal("REJECTED", false)?.code, "ABSTRACT_LOCKED");
  assert.equal(withdrawRefusal("WITHDRAWN", false)?.code, "ABSTRACT_LOCKED");
});

test("the withdrawable set includes MAYBE and excludes ACCEPTED and terminal statuses", () => {
  assert.deepEqual([...WITHDRAWABLE_STATUSES], ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "MAYBE"]);
  for (const status of WITHDRAWABLE_STATUSES) {
    assert.equal(isEditableStatus(status), true, `${status} must also be editable`);
  }
});

test("patch schema normalizes co-speaker emails to lowercase", () => {
  const parsed = speakerSubmissionPatchSchema.parse({
    speakers: [{ email: "Mixed.Case@Example.TEST", name: "Case", isPrimary: true }],
  });
  assert.equal(parsed.speakers?.[0].email, "mixed.case@example.test");
});
