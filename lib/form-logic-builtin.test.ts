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

test("a stored custom field that claimed a reserved key still drives its own rules", () => {
  // The server refuses this shape now, but data written before it could exist.
  const merged = withBuiltInAnswers({ format: "custom answer" }, { format: "Talk" });
  assert.equal(merged.format, "custom answer");
});
