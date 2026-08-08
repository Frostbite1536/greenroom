import assert from "node:assert/strict";
import test from "node:test";
import {
  EDITABLE_STATUSES,
  WITHDRAWABLE_STATUSES,
  isAbstractSpeaker,
  isEditableStatus,
  lockReasonFor,
  mergeAnswers,
  rosterChanged,
  speakerSubmissionPatchSchema,
  withdrawRefusal,
} from "@/lib/services/speaker-edit";
import {
  validateSubmission,
  validateSubmissionContent,
  validateSubmissionWindow,
  type FormSpec,
} from "@/lib/services/form-validation";

// --- status rules -----------------------------------------------------------

test("submitted, under-review and accepted abstracts are editable", () => {
  for (const status of ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "ACCEPTED"] as const) {
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

test("the editable set is exactly the four non-terminal statuses", () => {
  assert.deepEqual([...EDITABLE_STATUSES], ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "ACCEPTED"]);
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

test("the withdrawable set excludes ACCEPTED and both terminal statuses", () => {
  assert.deepEqual([...WITHDRAWABLE_STATUSES], ["DRAFT", "SUBMITTED", "UNDER_REVIEW"]);
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
