import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSubmission, type FormSpec } from "@/lib/services/form-validation";

const baseForm: FormSpec = {
  published: true,
  opensAt: null,
  closesAt: null,
  minSpeakers: 1,
  maxSpeakers: 2,
  maxBioLength: 100,
  fields: [
    { key: "title_note", label: "Title note", type: "SHORT_TEXT", required: true },
    { key: "bio", label: "Speaker bio", type: "LONG_TEXT", required: false },
  ],
};

const now = new Date(Date.UTC(2026, 2, 1, 12));

test("valid submission passes", () => {
  const err = validateSubmission(
    baseForm,
    { speakerCount: 1, answers: { title_note: "hi", bio: "short" } },
    now,
  );
  assert.equal(err, null);
});

test("unpublished form is rejected", () => {
  const err = validateSubmission(
    { ...baseForm, published: false },
    { speakerCount: 1, answers: { title_note: "hi" } },
    now,
  );
  assert.equal(err?.code, "FORM_UNPUBLISHED");
});

test("closed window is rejected", () => {
  const err = validateSubmission(
    { ...baseForm, closesAt: new Date(Date.UTC(2026, 1, 1)) },
    { speakerCount: 1, answers: { title_note: "hi" } },
    now,
  );
  assert.equal(err?.code, "FORM_CLOSED");
});

test("not-yet-open window is rejected", () => {
  const err = validateSubmission(
    { ...baseForm, opensAt: new Date(Date.UTC(2026, 3, 1)) },
    { speakerCount: 1, answers: { title_note: "hi" } },
    now,
  );
  assert.equal(err?.code, "FORM_NOT_OPEN");
});

test("too many speakers is rejected", () => {
  const err = validateSubmission(
    baseForm,
    { speakerCount: 3, answers: { title_note: "hi" } },
    now,
  );
  assert.equal(err?.code, "TOO_MANY_SPEAKERS");
});

test("missing required field is reported", () => {
  const err = validateSubmission(baseForm, { speakerCount: 1, answers: {} }, now);
  assert.equal(err?.code, "FIELD_ERRORS");
  assert.ok(err?.fieldErrors?.title_note);
});

test("bio over max length is reported", () => {
  const err = validateSubmission(
    baseForm,
    { speakerCount: 1, answers: { title_note: "hi", bio: "x".repeat(101) } },
    now,
  );
  assert.equal(err?.code, "FIELD_ERRORS");
  assert.ok(err?.fieldErrors?.bio);
});
