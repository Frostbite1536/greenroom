/**
 * The authoring rules the builder has to get right for the server to accept a
 * save: option values that outlive their wording, and rule sources that include
 * the built-in submission questions.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  addOption,
  defaultRule,
  findRuleSource,
  nextOptionValue,
  normalizeOptions,
  operatorNeedsValue,
  relabelOption,
  removeOption,
  retargetRule,
  ruleSources,
} from "@/lib/form-builder-logic";
import {
  BUILT_IN_SUBMISSION_SOURCES,
  findFormShapeIssues,
} from "@/lib/services/form-shape-validation";

test("a new choice gets a stable value that renaming never touches", () => {
  const created = addOption(addOption([], "Beginner"), "Advanced");
  assert.deepEqual(created.map((option) => option.value), ["option_1", "option_2"]);

  const renamed = relabelOption(created, 0, "Newcomer");
  assert.equal(renamed[0].label, "Newcomer");
  assert.equal(renamed[0].value, created[0].value);
  assert.deepEqual(renamed.map((option) => option.value), created.map((option) => option.value));
});

test("generated values never collide with values already stored", () => {
  const stored = [{ label: "Beginner", value: "beginner" }, { label: "Advanced", value: "option_2" }];
  const grown = addOption(stored, "Expert");
  assert.equal(grown[2].value, "option_3");
  assert.equal(new Set(grown.map((option) => option.value)).size, 3);

  // Removing the tail must not hand the next choice a value that is still live.
  const afterRemove = addOption(removeOption(grown, 1), "Another");
  assert.equal(afterRemove.some((option) => option.value === "option_3"), true);
  assert.equal(new Set(afterRemove.map((option) => option.value)).size, afterRemove.length);
});

test("loading a stored option list leaves every existing value untouched", () => {
  const stored = [
    { label: "Beginner", value: "beginner" },
    { label: "Advanced", value: "advanced" },
  ];
  assert.deepEqual(normalizeOptions(stored), stored);
  // Only a value that does not exist at all is filled in, because the server
  // refuses a blank one outright.
  assert.deepEqual(
    normalizeOptions([{ label: "Legacy", value: "  " }]),
    [{ label: "Legacy", value: "option_1" }],
  );
});

test("relabelling a choice keeps the form acceptable to the shared validator", () => {
  const options = addOption(addOption([], "Beginner"), "Advanced");
  const field = {
    key: "audience",
    label: "Audience",
    type: "SELECT",
    options: relabelOption(options, 1, "Experienced"),
    conditionalLogic: null,
  };
  const guarded = {
    key: "deep_dive",
    label: "Deep dive detail",
    type: "LONG_TEXT",
    conditionalLogic: { match: "all" as const, rules: [{ fieldKey: "audience", operator: "equals", value: options[1].value }] },
  };
  assert.deepEqual(findFormShapeIssues([field, guarded]), []);
});

test("the rule source list is the server's built-in inventory plus this form's questions", () => {
  const sources = ruleSources(
    [
      { key: "audience", label: "Audience", type: "SELECT", options: [{ label: "Beginner", value: "beginner" }] },
      { key: "self", label: "Self", type: "SHORT_TEXT" },
    ],
    "self",
  );
  const builtInKeys = sources.filter((source) => source.builtIn).map((source) => source.key);
  // Every declared built-in is offered — Format above all, which is why the
  // whole feature exists.
  assert.deepEqual(
    builtInKeys,
    BUILT_IN_SUBMISSION_SOURCES.filter((source) =>
      source.operators.some((operator) => operator !== "isEmpty"),
    ).map((source) => source.key),
  );
  assert.ok(builtInKeys.includes("format"));
  // The field's own key is never offered: it could only ever be a cycle.
  assert.deepEqual(sources.filter((source) => !source.builtIn).map((source) => source.key), ["audience"]);
  assert.deepEqual(findRuleSource(sources, "audience")?.optionValues, [{ label: "Beginner", value: "beginner" }]);
  assert.equal(findRuleSource(sources, "self"), null);
});

test("built-in sources only offer comparisons submission-time validation also treats as hidden", () => {
  const sources = ruleSources([], null);
  for (const source of sources.filter((entry) => entry.builtIn)) {
    // `isEmpty`/`notEquals` are true for an unanswered built-in server-side and
    // false client-side, which would show the submitter nothing and then refuse
    // their submission for not answering it.
    assert.equal(source.operators.includes("isEmpty"), false, source.key);
    assert.equal(source.operators.includes("notEquals"), false, source.key);
  }
  // The roster can only ever be asked whether anyone is on it.
  assert.deepEqual(findRuleSource(sources, "speakers")?.operators, ["isNotEmpty"]);
});

test("a freshly added rule is already valid, so the first Save is not a refusal", () => {
  const sources = ruleSources([], null);
  const seeded = defaultRule(sources[0]);
  assert.equal(operatorNeedsValue(seeded.operator), false);
  assert.equal(seeded.value, undefined);

  const issues = findFormShapeIssues([
    { key: "extra", label: "Extra", type: "SHORT_TEXT", conditionalLogic: { match: "all", rules: [seeded] } },
  ]);
  assert.deepEqual(issues, []);
});

test("re-pointing a rule drops a value the new source could never match", () => {
  const sources = ruleSources(
    [{ key: "audience", label: "Audience", type: "SELECT", options: [{ label: "Beginner", value: "beginner" }] }],
    null,
  );
  const audience = findRuleSource(sources, "audience")!;
  const moved = retargetRule({ fieldKey: "title", operator: "equals", value: "anything" }, audience);
  assert.deepEqual(moved, { fieldKey: "audience", operator: "equals", value: "beginner" });

  // An operator the new source cannot answer falls back rather than saving a
  // shape the server refuses.
  const speakers = findRuleSource(sources, "speakers")!;
  assert.deepEqual(retargetRule({ fieldKey: "audience", operator: "equals", value: "beginner" }, speakers), {
    fieldKey: "speakers",
    operator: "isNotEmpty",
  });
});
