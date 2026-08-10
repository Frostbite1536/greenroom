/**
 * Built-in submission questions as conditional-logic sources, client-side.
 *
 * The server's shape validator accepts a rule pointing at Session format; this
 * pins that the renderer then actually evaluates it, which is the half that was
 * missing — a form could be saved with a rule nobody's answer could ever satisfy.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { builtInAnswerMap, resolveVisibleFields, withBuiltInAnswers } from "@/lib/form-logic";
import { RESERVED_FIELD_KEYS } from "@/lib/services/form-shape-validation";
import { DEFAULT_SESSION_FORMAT } from "@/lib/cfp-formats";
import { initialPreviewBuiltIns, previewBuiltInAnswers } from "@/lib/form-builder-logic";

const guarded = (fieldKey: string, operator: string, value?: string) => [
  {
    key: "workshop_room",
    type: "SHORT_TEXT",
    required: false,
    conditionalLogic: { match: "all" as const, rules: [{ fieldKey, operator, value }] },
  },
];

test("the built-in answer map covers exactly the keys the server declares", () => {
  // Drift guard: a source the server accepts but the renderer cannot answer
  // silently hides the field it guards, forever.
  assert.deepEqual(
    Object.keys(builtInAnswerMap({})).sort(),
    [...RESERVED_FIELD_KEYS].sort(),
  );
});

test("a rule on Session format decides visibility instead of being ignored", () => {
  const fields = guarded("format", "equals", "Workshop");
  assert.deepEqual(
    resolveVisibleFields(fields, withBuiltInAnswers({}, { format: "Workshop" })).map((f) => f.key),
    ["workshop_room"],
  );
  assert.deepEqual(
    resolveVisibleFields(fields, withBuiltInAnswers({}, { format: DEFAULT_SESSION_FORMAT })).map((f) => f.key),
    [],
  );
});

test("an unanswered built-in reads as unanswered, not as a match", () => {
  const fields = guarded("title", "isNotEmpty");
  assert.deepEqual(resolveVisibleFields(fields, withBuiltInAnswers({}, {})).map((f) => f.key), []);
  assert.deepEqual(
    resolveVisibleFields(fields, withBuiltInAnswers({}, { title: "  " })).map((f) => f.key),
    [],
  );
  assert.deepEqual(
    resolveVisibleFields(fields, withBuiltInAnswers({}, { title: "A talk" })).map((f) => f.key),
    ["workshop_room"],
  );
});

test("the speaker roster counts only entries a submitter actually filled in", () => {
  const fields = guarded("speakers", "isNotEmpty");
  const blankRow = withBuiltInAnswers({}, { speakers: [{ name: "", email: "" }] });
  assert.deepEqual(resolveVisibleFields(fields, blankRow).map((f) => f.key), []);
  const realRow = withBuiltInAnswers({}, { speakers: [{ name: "Ada", email: "ada@example.test" }] });
  assert.deepEqual(resolveVisibleFields(fields, realRow).map((f) => f.key), ["workshop_room"]);
});

test("the builder preview's own call hides the question whose format rule does not match", () => {
  // The exact fixture and the exact call `Preview` makes, so the unit gate and
  // the smoke gate cannot disagree about what the preview should render. The
  // smoke's page-wide substring search could not tell this apart from the
  // editor list, which renders every question's label unconditionally.
  const fields = [
    { key: "audience_level", type: "SELECT", required: false, conditionalLogic: null },
    {
      key: "talk_extra",
      type: "SHORT_TEXT",
      required: false,
      conditionalLogic: { match: "all" as const, rules: [{ fieldKey: "format", operator: "equals", value: "Talk" }] },
    },
    {
      key: "workshop_extra",
      type: "SHORT_TEXT",
      required: false,
      conditionalLogic: { match: "all" as const, rules: [{ fieldKey: "format", operator: "equals", value: "Workshop" }] },
    },
  ];
  const atFirstPaint = resolveVisibleFields(
    fields,
    withBuiltInAnswers({}, { title: "", format: DEFAULT_SESSION_FORMAT }),
  ).map((field) => field.key);
  assert.deepEqual(atFirstPaint, ["audience_level", "talk_extra"]);

  const afterChoosingWorkshop = resolveVisibleFields(
    fields,
    withBuiltInAnswers({}, { title: "", format: "Workshop" }),
  ).map((field) => field.key);
  assert.deepEqual(afterChoosingWorkshop, ["audience_level", "workshop_extra"]);
});

test("every built-in source the preview offers drives visibility in both directions", () => {
  // One rule per source, through the exact call `Preview` makes. Before this,
  // abstract/categoryId/speakers had no preview control at all, so their rules
  // sat permanently on the "unanswered" side.
  const cases = [
    { key: "title_q", source: "title", operator: "equals", value: "Kickoff", match: { title: "Kickoff" }, miss: { title: "Other" } },
    { key: "abstract_q", source: "abstract", operator: "isNotEmpty", value: undefined, match: { abstract: "Some body" }, miss: { abstract: "" } },
    { key: "format_q", source: "format", operator: "equals", value: "Workshop", match: { format: "Workshop" }, miss: { format: "Talk" } },
    { key: "category_q", source: "categoryId", operator: "equals", value: "cat_1", match: { categoryId: "cat_1" }, miss: { categoryId: "cat_2" } },
    // The preview holds the roster as a count, so this is the knob it turns.
    { key: "speakers_q", source: "speakers", operator: "isNotEmpty", value: undefined, match: { speakerCount: 1 }, miss: { speakerCount: 0 } },
  ] as const;

  for (const entry of cases) {
    const fields = [
      {
        key: entry.key,
        type: "SHORT_TEXT",
        required: false,
        conditionalLogic: {
          match: "all" as const,
          rules: [{ fieldKey: entry.source, operator: entry.operator, value: entry.value }],
        },
      },
    ];
    const shown = resolveVisibleFields(
      fields,
      withBuiltInAnswers({}, previewBuiltInAnswers({ ...initialPreviewBuiltIns(DEFAULT_SESSION_FORMAT), ...entry.match })),
    );
    assert.deepEqual(shown.map((f) => f.key), [entry.key], `${entry.source} should show its field when matched`);

    const hidden = resolveVisibleFields(
      fields,
      withBuiltInAnswers({}, previewBuiltInAnswers({ ...initialPreviewBuiltIns(DEFAULT_SESSION_FORMAT), ...entry.miss })),
    );
    assert.deepEqual(hidden.map((f) => f.key), [], `${entry.source} should hide its field when unmatched`);
  }
});

test("a stored custom field that claimed a reserved key still drives its own rules", () => {
  // The server refuses this shape now, but data written before it could exist.
  const merged = withBuiltInAnswers({ format: "custom answer" }, { format: "Talk" });
  assert.equal(merged.format, "custom answer");
});
