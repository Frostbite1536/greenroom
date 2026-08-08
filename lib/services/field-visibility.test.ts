import assert from "node:assert/strict";
import test from "node:test";
import {
  parseConditionalLogic,
  parseFieldOptions,
  resolveVisibleFields,
  validateAnswerType,
  type VisibilityField,
} from "@/lib/services/field-visibility";
import { validateSubmissionContent, type FormSpec } from "@/lib/services/form-validation";

const field = (over: Partial<VisibilityField> & { key: string }): VisibilityField => ({
  label: over.key,
  type: "SHORT_TEXT",
  required: false,
  conditionalLogic: null,
  options: null,
  ...over,
});

// --- visibility -------------------------------------------------------------

test("a field with no rules is always asked", () => {
  const fields = [field({ key: "title" })];
  assert.deepEqual(resolveVisibleFields(fields, {}).map((f) => f.key), ["title"]);
});

test("a dependent field appears only when its rule matches", () => {
  const fields = [
    field({ key: "audience", type: "SELECT" }),
    field({
      key: "workshop_needs",
      conditionalLogic: { match: "all", rules: [{ fieldKey: "audience", operator: "equals", value: "advanced" }] },
    }),
  ];
  assert.deepEqual(resolveVisibleFields(fields, { audience: "beginner" }).map((f) => f.key), ["audience"]);
  assert.deepEqual(
    resolveVisibleFields(fields, { audience: "advanced" }).map((f) => f.key),
    ["audience", "workshop_needs"],
  );
});

test("match:any needs one rule, match:all needs every rule", () => {
  const rules = [
    { fieldKey: "a", operator: "equals", value: "yes" },
    { fieldKey: "b", operator: "equals", value: "yes" },
  ];
  const any = [field({ key: "t", conditionalLogic: { match: "any", rules } })];
  const all = [field({ key: "t", conditionalLogic: { match: "all", rules } })];
  assert.equal(resolveVisibleFields(any, { a: "yes", b: "no" }).length, 1);
  assert.equal(resolveVisibleFields(all, { a: "yes", b: "no" }).length, 0);
  assert.equal(resolveVisibleFields(all, { a: "yes", b: "yes" }).length, 1);
});

test("visibility cascades: a hidden parent's stale answer cannot keep a child alive", () => {
  // `detail` depends on `followup`, which is itself hidden. Even though a stale
  // answer for `followup` is stored (an edit after the parent changed), neither
  // field is being asked.
  const fields = [
    field({ key: "kind", type: "SELECT" }),
    field({
      key: "followup",
      conditionalLogic: { match: "all", rules: [{ fieldKey: "kind", operator: "equals", value: "workshop" }] },
    }),
    field({
      key: "detail",
      conditionalLogic: { match: "all", rules: [{ fieldKey: "followup", operator: "isNotEmpty" }] },
    }),
  ];
  const visible = resolveVisibleFields(fields, { kind: "talk", followup: "stale answer" });
  assert.deepEqual(visible.map((f) => f.key), ["kind"]);
});

test("a circular rule set terminates instead of looping", () => {
  const fields = [
    field({ key: "a", conditionalLogic: { match: "all", rules: [{ fieldKey: "b", operator: "isNotEmpty" }] } }),
    field({ key: "b", conditionalLogic: { match: "all", rules: [{ fieldKey: "a", operator: "isNotEmpty" }] } }),
  ];
  const visible = resolveVisibleFields(fields, { a: "x", b: "y" });
  assert.ok(Array.isArray(visible));
});

// --- typed answers ----------------------------------------------------------

test("select answers must be one of the field's options", () => {
  const select = field({ key: "audience", type: "SELECT", options: [{ label: "Beginner", value: "beginner" }] });
  assert.equal(validateAnswerType(select, "beginner"), null);
  assert.ok(validateAnswerType(select, "expert"));
});

test("multi-select answers must all be options, with no repeats", () => {
  const multi = field({
    key: "topics", type: "MULTI_SELECT",
    options: [{ label: "AI", value: "ai" }, { label: "Community", value: "community" }],
  });
  assert.equal(validateAnswerType(multi, ["ai", "community"]), null);
  assert.ok(validateAnswerType(multi, ["ai", "quantum"]));
  assert.ok(validateAnswerType(multi, ["ai", "ai"]));
  assert.ok(validateAnswerType(multi, "ai"), "a bare string is not a multi-select answer");
});

test("numbers accept the renderer's string input but reject non-numbers", () => {
  const number = field({ key: "rating", type: "NUMBER" });
  assert.equal(validateAnswerType(number, 4.5), null);
  assert.equal(validateAnswerType(number, "4.5"), null);
  assert.ok(validateAnswerType(number, "abc"));
  assert.ok(validateAnswerType(number, true));
  assert.ok(validateAnswerType(number, ["4"]));
});

test("urls must parse", () => {
  const url = field({ key: "website", type: "URL" });
  assert.equal(validateAnswerType(url, "https://example.test/x"), null);
  assert.ok(validateAnswerType(url, "example.test"));
});

test("checkboxes are boolean only, and null means unanswered", () => {
  const checkbox = field({ key: "consent", type: "CHECKBOX" });
  assert.equal(validateAnswerType(checkbox, true), null);
  assert.equal(validateAnswerType(checkbox, false), null);
  assert.equal(validateAnswerType(checkbox, null), null);
  assert.ok(validateAnswerType(checkbox, "yes"));
});

test("text fields reject structured values", () => {
  assert.ok(validateAnswerType(field({ key: "t", type: "SHORT_TEXT" }), ["a"]));
  assert.equal(validateAnswerType(field({ key: "t", type: "LONG_TEXT" }), "fine"), null);
});

// --- defensive JSON parsing -------------------------------------------------

test("malformed stored options and logic degrade to null rather than throwing", () => {
  assert.equal(parseFieldOptions(null), null);
  assert.equal(parseFieldOptions("nope"), null);
  assert.equal(parseFieldOptions([{ label: "no value" }]), null);
  assert.deepEqual(parseFieldOptions([{ value: "a" }]), [{ label: "a", value: "a" }]);

  assert.equal(parseConditionalLogic(null), null);
  assert.equal(parseConditionalLogic({ match: "sometimes", rules: [] }), null);
  assert.equal(parseConditionalLogic({ match: "all", rules: [] }), null);
  assert.equal(parseConditionalLogic({ match: "all", rules: [{ fieldKey: 1 }] }), null);
  assert.deepEqual(parseConditionalLogic({ match: "any", rules: [{ fieldKey: "a", operator: "equals", value: "x" }] }), {
    match: "any",
    rules: [{ fieldKey: "a", operator: "equals", value: "x" }],
  });
});

// --- the audit2#3 regression, end to end through the shared validator --------

const conditionalForm: FormSpec = {
  published: true,
  opensAt: null,
  closesAt: null,
  minSpeakers: 1,
  maxSpeakers: 2,
  maxBioLength: 500,
  fields: [
    { key: "audience", label: "Audience", type: "SELECT", required: false,
      options: [{ label: "Beginner", value: "beginner" }, { label: "Advanced", value: "advanced" }] },
    { key: "workshop_needs", label: "Workshop needs", type: "SHORT_TEXT", required: true,
      conditionalLogic: { match: "all", rules: [{ fieldKey: "audience", operator: "equals", value: "advanced" }] } },
    { key: "consent", label: "Consent", type: "CHECKBOX", required: true },
  ],
};

test("a required field that was never shown does not block a valid submission", () => {
  // audit2#3: the renderer only submits visible fields, so requiring a hidden
  // one rejected submissions that were entirely correct.
  const error = validateSubmissionContent(conditionalForm, {
    speakerCount: 1,
    answers: { audience: "beginner", consent: true },
  });
  assert.equal(error, null);
});

test("the same field is required once the answer that reveals it is given", () => {
  const error = validateSubmissionContent(conditionalForm, {
    speakerCount: 1,
    answers: { audience: "advanced", consent: true },
  });
  assert.equal(error?.code, "FIELD_ERRORS");
  assert.ok(error?.fieldErrors?.workshop_needs);
});

test("a required checkbox must be ticked, not merely present", () => {
  const error = validateSubmissionContent(conditionalForm, {
    speakerCount: 1,
    answers: { audience: "beginner", consent: false },
  });
  assert.equal(error?.code, "FIELD_ERRORS");
  assert.ok(error?.fieldErrors?.consent?.[0].includes("ticked"));
});

test("an answer outside the field's options is refused by the server", () => {
  const error = validateSubmissionContent(conditionalForm, {
    speakerCount: 1,
    answers: { audience: "smuggled", consent: true },
  });
  assert.equal(error?.code, "FIELD_ERRORS");
  assert.ok(error?.fieldErrors?.audience);
});
