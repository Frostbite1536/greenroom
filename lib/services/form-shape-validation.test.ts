import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILT_IN_SUBMISSION_SOURCES,
  LOGIC_OPERATORS,
  RESERVED_FIELD_KEYS,
  findFormShapeIssues,
  formShapeFieldErrors,
  type ShapeField,
} from "@/lib/services/form-shape-validation";

const codes = (fields: readonly ShapeField[]) =>
  findFormShapeIssues(fields).map((issue) => issue.code);

const audience: ShapeField = {
  key: "audience",
  label: "Audience",
  type: "SELECT",
  options: [
    { label: "Beginner", value: "beginner" },
    { label: "Advanced", value: "advanced" },
  ],
};

const workshopNeeds: ShapeField = {
  key: "workshop_needs",
  label: "Workshop needs",
  type: "SHORT_TEXT",
  conditionalLogic: { match: "all", rules: [{ fieldKey: "audience", operator: "equals", value: "advanced" }] },
};

// --- the shared inventory ---------------------------------------------------

test("the built-in inventory covers every input the CFP form renders itself", () => {
  // Derived from components/cfp-form.tsx: cfp-title, cfp-abstract, cfp-format,
  // cfp-category and the Participants roster. Format is required to be here.
  assert.deepEqual(RESERVED_FIELD_KEYS, ["title", "abstract", "format", "categoryId", "speakers"]);
  assert.ok(BUILT_IN_SUBMISSION_SOURCES.some((source) => source.key === "format"));
});

test("no built-in claims a closed value set the server does not actually enforce", () => {
  // format is a free string at the submission boundary and category values are
  // event-scoped rows, so only key validity is checkable at shape-write time.
  for (const source of BUILT_IN_SUBMISSION_SOURCES) {
    assert.equal(source.values, undefined, source.key);
  }
});

test("the operator allowlist is exactly the evaluator's", () => {
  assert.deepEqual([...LOGIC_OPERATORS], ["isEmpty", "isNotEmpty", "equals", "notEquals", "includes"]);
});

// --- payloads that must keep working ----------------------------------------

test("an empty form has nothing wrong with it", () => {
  assert.deepEqual(findFormShapeIssues([]), []);
});

test("a rule on a sibling question's real option value is accepted", () => {
  assert.deepEqual(codes([audience, workshopNeeds]), []);
});

test("rules on built-in submission sources are accepted", () => {
  assert.deepEqual(
    codes([
      {
        key: "recording_ok",
        label: "Happy to be recorded?",
        type: "CHECKBOX",
        conditionalLogic: {
          match: "any",
          rules: [
            { fieldKey: "format", operator: "equals", value: "Workshop" },
            { fieldKey: "title", operator: "isNotEmpty" },
            { fieldKey: "categoryId", operator: "notEquals", value: "cat_123" },
            { fieldKey: "speakers", operator: "isNotEmpty" },
          ],
        },
      },
    ]),
    [],
  );
});

test("a rule on a half-built option question is not treated as impossible", () => {
  // The builder saves work in progress; a SELECT with no options yet must not
  // make every rule pointing at it unsaveable.
  const empty: ShapeField = { key: "audience", label: "Audience", type: "SELECT", options: [] };
  assert.deepEqual(codes([empty, workshopNeeds]), []);
});

test("free-text sources accept any comparison value", () => {
  assert.deepEqual(
    codes([
      { key: "city", label: "City", type: "SHORT_TEXT" },
      {
        key: "visa",
        label: "Visa help",
        type: "CHECKBOX",
        conditionalLogic: { match: "all", rules: [{ fieldKey: "city", operator: "includes", value: "Berlin" }] },
      },
    ]),
    [],
  );
});

test("relabelling an option keeps its stored value, and stays valid", () => {
  const reworded: ShapeField = {
    ...audience,
    options: [
      { label: "New to the topic", value: "beginner" },
      { label: "Experienced", value: "advanced" },
    ],
  };
  assert.deepEqual(codes([reworded, workshopNeeds]), []);
});

// --- source-key integrity ---------------------------------------------------

test("a rule pointing at a question that is not in the payload is refused", () => {
  const orphan: ShapeField = {
    ...workshopNeeds,
    conditionalLogic: { match: "all", rules: [{ fieldKey: "deleted_field", operator: "equals", value: "x" }] },
  };
  const issues = findFormShapeIssues([orphan]);
  assert.deepEqual(issues.map((issue) => issue.code), ["FORM_LOGIC_SOURCE_UNKNOWN"]);
  assert.equal(issues[0].fieldKey, "workshop_needs");
  assert.match(issues[0].message, /deleted_field/);
});

test("a custom key that collides with a built-in source is refused", () => {
  const issues = findFormShapeIssues([{ key: "format", label: "Preferred format", type: "SHORT_TEXT" }]);
  assert.deepEqual(issues.map((issue) => issue.code), ["FORM_FIELD_KEY_RESERVED"]);
  assert.equal(issues[0].fieldKey, "format");
});

// --- cycles -----------------------------------------------------------------

test("a question that depends on its own answer is refused", () => {
  const issues = findFormShapeIssues([
    {
      key: "loop",
      label: "Loop",
      type: "SHORT_TEXT",
      conditionalLogic: { match: "all", rules: [{ fieldKey: "loop", operator: "isNotEmpty" }] },
    },
  ]);
  assert.deepEqual(issues.map((issue) => issue.code), ["FORM_LOGIC_CYCLE"]);
  assert.match(issues[0].message, /its own answer/);
});

test("a two-question loop is refused once, attributed to the earlier question", () => {
  const issues = findFormShapeIssues([
    {
      key: "alpha",
      label: "Alpha",
      type: "SHORT_TEXT",
      conditionalLogic: { match: "all", rules: [{ fieldKey: "beta", operator: "isNotEmpty" }] },
    },
    {
      key: "beta",
      label: "Beta",
      type: "SHORT_TEXT",
      conditionalLogic: { match: "all", rules: [{ fieldKey: "alpha", operator: "isNotEmpty" }] },
    },
  ]);
  assert.deepEqual(issues.map((issue) => issue.code), ["FORM_LOGIC_CYCLE"]);
  assert.equal(issues[0].fieldKey, "alpha");
  assert.match(issues[0].message, /“Alpha” → “Beta” → “Alpha”/);
});

test("a three-question loop is refused", () => {
  const link = (key: string, label: string, on: string): ShapeField => ({
    key,
    label,
    type: "SHORT_TEXT",
    conditionalLogic: { match: "all", rules: [{ fieldKey: on, operator: "isNotEmpty" }] },
  });
  const issues = findFormShapeIssues([link("a", "A", "b"), link("b", "B", "c"), link("c", "C", "a")]);
  assert.deepEqual(issues.map((issue) => issue.code), ["FORM_LOGIC_CYCLE"]);
  assert.equal(issues[0].fieldKey, "a");
});

test("a long dependency chain without a loop is accepted", () => {
  const chain: ShapeField[] = [{ key: "f0", label: "F0", type: "SHORT_TEXT" }];
  for (let index = 1; index < 500; index++) {
    chain.push({
      key: `f${index}`,
      label: `F${index}`,
      type: "SHORT_TEXT",
      conditionalLogic: { match: "all", rules: [{ fieldKey: `f${index - 1}`, operator: "isNotEmpty" }] },
    });
  }
  assert.deepEqual(codes(chain), []);
});

test("built-in sources are terminal and never form a cycle", () => {
  assert.deepEqual(
    codes([
      {
        key: "title_note",
        label: "Title note",
        type: "SHORT_TEXT",
        conditionalLogic: { match: "all", rules: [{ fieldKey: "title", operator: "isNotEmpty" }] },
      },
    ]),
    [],
  );
});

// --- impossible rules -------------------------------------------------------

test("an operator outside the allowlist is refused", () => {
  const issues = findFormShapeIssues([
    audience,
    {
      ...workshopNeeds,
      conditionalLogic: { match: "all", rules: [{ fieldKey: "audience", operator: "greaterThan", value: "beginner" }] },
    },
  ]);
  assert.deepEqual(issues.map((issue) => issue.code), ["FORM_LOGIC_OPERATOR_UNSUPPORTED"]);
});

test("a comparison operator on a source that has no single answer is refused", () => {
  const issues = findFormShapeIssues([
    {
      key: "bio",
      label: "Bio",
      type: "LONG_TEXT",
      conditionalLogic: { match: "all", rules: [{ fieldKey: "speakers", operator: "equals", value: "2" }] },
    },
  ]);
  assert.deepEqual(issues.map((issue) => issue.code), ["FORM_LOGIC_OPERATOR_UNSUPPORTED"]);
});

test("equals, notEquals and includes each need a value", () => {
  for (const operator of ["equals", "notEquals", "includes"] as const) {
    const issues = findFormShapeIssues([
      { key: "city", label: "City", type: "SHORT_TEXT" },
      {
        key: "visa",
        label: "Visa help",
        type: "CHECKBOX",
        conditionalLogic: { match: "all", rules: [{ fieldKey: "city", operator }] },
      },
    ]);
    assert.deepEqual(issues.map((issue) => issue.code), ["FORM_LOGIC_VALUE_MISSING"], operator);
  }
});

test("a blank or whitespace comparison value counts as missing", () => {
  for (const value of ["", "   "]) {
    const issues = findFormShapeIssues([
      { key: "city", label: "City", type: "SHORT_TEXT" },
      {
        key: "visa",
        label: "Visa help",
        type: "CHECKBOX",
        conditionalLogic: { match: "all", rules: [{ fieldKey: "city", operator: "equals", value }] },
      },
    ]);
    assert.deepEqual(issues.map((issue) => issue.code), ["FORM_LOGIC_VALUE_MISSING"], JSON.stringify(value));
  }
});

test("false and zero are real comparison values, not missing ones", () => {
  assert.deepEqual(
    codes([
      { key: "rating", label: "Rating", type: "NUMBER" },
      {
        key: "why",
        label: "Why",
        type: "SHORT_TEXT",
        conditionalLogic: {
          match: "any",
          rules: [
            { fieldKey: "rating", operator: "equals", value: 0 },
            { fieldKey: "rating", operator: "notEquals", value: false },
          ],
        },
      },
    ]),
    [],
  );
});

test("isEmpty and isNotEmpty never need a value", () => {
  assert.deepEqual(
    codes([
      audience,
      {
        ...workshopNeeds,
        conditionalLogic: { match: "all", rules: [{ fieldKey: "audience", operator: "isEmpty" }] },
      },
    ]),
    [],
  );
});

test("a rule value that is not one of an option question's stored values is refused", () => {
  const issues = findFormShapeIssues([
    audience,
    {
      ...workshopNeeds,
      // The label, not the stored value — the exact mistake a builder makes.
      conditionalLogic: { match: "all", rules: [{ fieldKey: "audience", operator: "equals", value: "Advanced" }] },
    },
  ]);
  assert.deepEqual(issues.map((issue) => issue.code), ["FORM_LOGIC_VALUE_NOT_AN_OPTION"]);
  assert.equal(issues[0].fieldKey, "workshop_needs");
});

test("multi-select option membership is enforced for includes", () => {
  const issues = findFormShapeIssues([
    {
      key: "topics",
      label: "Topics",
      type: "MULTI_SELECT",
      options: [{ label: "AI", value: "ai" }, { label: "Community", value: "community" }],
    },
    {
      key: "ai_detail",
      label: "AI detail",
      type: "LONG_TEXT",
      conditionalLogic: { match: "all", rules: [{ fieldKey: "topics", operator: "includes", value: "ml" }] },
    },
  ]);
  assert.deepEqual(issues.map((issue) => issue.code), ["FORM_LOGIC_VALUE_NOT_AN_OPTION"]);
});

test("a built-in source with a server-enforced value set has that set enforced", () => {
  // No built-in declares one today; this proves the slot works if one ever does.
  const issues = findFormShapeIssues(
    [
      {
        key: "stage_note",
        label: "Stage note",
        type: "SHORT_TEXT",
        conditionalLogic: { match: "all", rules: [{ fieldKey: "format", operator: "equals", value: "Keynote" }] },
      },
    ],
    {
      builtInSources: [
        { key: "format", label: "Session format", operators: LOGIC_OPERATORS, values: ["Talk", "Workshop"] },
      ],
    },
  );
  assert.deepEqual(issues.map((issue) => issue.code), ["FORM_LOGIC_VALUE_NOT_AN_OPTION"]);
});

// --- option discipline ------------------------------------------------------

test("an option with a blank value is refused", () => {
  const issues = findFormShapeIssues([
    { ...audience, options: [{ label: "Beginner", value: "" }, { label: "Advanced", value: "advanced" }] },
  ]);
  assert.deepEqual(issues.map((issue) => issue.code), ["FORM_OPTION_VALUE_EMPTY"]);
  assert.equal(issues[0].fieldKey, "audience");
});

test("an option whose value is only whitespace is refused", () => {
  const issues = findFormShapeIssues([
    { ...audience, options: [{ label: "Beginner", value: "   " }] },
  ]);
  assert.deepEqual(issues.map((issue) => issue.code), ["FORM_OPTION_VALUE_EMPTY"]);
});

test("two options that collide only after trimming are refused", () => {
  const issues = findFormShapeIssues([
    {
      ...audience,
      options: [
        { label: "Beginner", value: "beginner" },
        { label: "Beginner again", value: " beginner " },
      ],
    },
  ]);
  assert.deepEqual(issues.map((issue) => issue.code), ["FORM_OPTION_VALUE_DUPLICATE"]);
  assert.match(issues[0].message, /beginner/);
});

test("two options with identical labels but distinct values are allowed", () => {
  assert.deepEqual(
    codes([
      {
        ...audience,
        options: [
          { label: "Other", value: "other_a" },
          { label: "Other", value: "other_b" },
        ],
      },
    ]),
    [],
  );
});

test("option discipline applies to any question that carries options", () => {
  // The schema permits options on non-option types; a blank value there is
  // still a stored value nobody can pick.
  const issues = findFormShapeIssues([
    { key: "note", label: "Note", type: "SHORT_TEXT", options: [{ label: "A", value: "" }] },
  ]);
  assert.deepEqual(issues.map((issue) => issue.code), ["FORM_OPTION_VALUE_EMPTY"]);
});

// --- reporting --------------------------------------------------------------

test("issues are reported in payload order, with cycles last", () => {
  const issues = findFormShapeIssues([
    { key: "title", label: "Title", type: "SHORT_TEXT" },
    {
      key: "loop",
      label: "Loop",
      type: "SHORT_TEXT",
      conditionalLogic: { match: "all", rules: [{ fieldKey: "loop", operator: "isNotEmpty" }] },
    },
    { key: "choices", label: "Choices", type: "SELECT", options: [{ label: "A", value: "" }] },
  ]);
  assert.deepEqual(issues.map((issue) => issue.code), [
    "FORM_FIELD_KEY_RESERVED",
    "FORM_OPTION_VALUE_EMPTY",
    "FORM_LOGIC_CYCLE",
  ]);
});

test("field errors group every message under the question that has to change", () => {
  const issues = findFormShapeIssues([
    {
      key: "visa",
      label: "Visa help",
      type: "SELECT",
      options: [{ label: "Yes", value: "" }],
      conditionalLogic: {
        match: "all",
        rules: [
          { fieldKey: "nope", operator: "equals", value: "x" },
          { fieldKey: "title", operator: "equals" },
        ],
      },
    },
  ]);
  const fieldErrors = formShapeFieldErrors(issues);
  assert.deepEqual(Object.keys(fieldErrors), ["visa"]);
  assert.equal(fieldErrors.visa.length, 3);
});

test("every refusal reads as plain language, not as a code", () => {
  const issues = findFormShapeIssues([
    { key: "speakers", label: "Speakers", type: "SHORT_TEXT", options: [{ label: "A", value: "" }, { label: "B", value: "" }] },
    {
      key: "loop",
      label: "Loop",
      type: "SHORT_TEXT",
      conditionalLogic: {
        match: "all",
        rules: [
          { fieldKey: "loop", operator: "isNotEmpty" },
          { fieldKey: "gone", operator: "equals", value: "x" },
          { fieldKey: "speakers", operator: "wat", value: "x" },
        ],
      },
    },
  ]);
  assert.ok(issues.length >= 5, String(issues.length));
  for (const issue of issues) {
    // Same bar the B5 refusals hold: no shouty identifiers in operator-facing copy.
    assert.doesNotMatch(issue.message, /[A-Z_]{4,}/, issue.message);
  }
});
