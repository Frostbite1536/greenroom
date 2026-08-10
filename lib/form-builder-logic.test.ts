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
  initialPreviewBuiltIns,
  normalizeOptions,
  operatorNeedsValue,
  previewBuiltInAnswers,
  relabelOption,
  removeOption,
  retargetRule,
  ruleSources,
  sampleSpeakers,
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

test("the preview can answer every built-in source the picker offers", () => {
  // The defect this closes: the picker offered abstract, categoryId and
  // speakers, but the preview held no value for them, so those rules evaluated
  // against an empty default forever and the preview disagreed with the public
  // form for exactly the sources the builder had just made writable.
  const offered = ruleSources([], null)
    .filter((source) => source.builtIn)
    .map((source) => source.key)
    .sort();
  const answerable = Object.keys(previewBuiltInAnswers(initialPreviewBuiltIns("Talk"))).sort();
  assert.deepEqual(offered, answerable);
});

test("the preview starts where the public form's first paint starts", () => {
  const start = initialPreviewBuiltIns("Talk");
  assert.deepEqual(start, { title: "", abstract: "", format: "Talk", categoryId: "", speakerCount: 0 });
  // The public roster begins as one empty row, which counts as nobody.
  assert.deepEqual(sampleSpeakers(start.speakerCount), []);
});

test("the sample roster is presence-only and bounded", () => {
  assert.equal(sampleSpeakers(3).length, 3);
  assert.equal(sampleSpeakers(-4).length, 0);
  assert.equal(sampleSpeakers(999).length, 20);
  assert.equal(sampleSpeakers(Number.NaN).length, 0);
  // Every entry has to read as filled in, or `isNotEmpty` would never fire.
  assert.ok(sampleSpeakers(2).every((speaker) => speaker.name.length > 0 && speaker.email.length > 0));
});

test("a built-in's convenience value list never rewrites a value the author already wrote", () => {
  // Categories are created and deleted after a form is saved, and the server
  // checks the key rather than the value, so a stale id must survive an
  // operator change instead of silently snapping to whichever category is first.
  const sources = ruleSources([], null, {
    categoryId: [{ label: "Applied AI", value: "cat_1" }, { label: "Platform", value: "cat_2" }],
  });
  const category = findRuleSource(sources, "categoryId")!;
  assert.deepEqual(category.optionValues, [
    { label: "Applied AI", value: "cat_1" },
    { label: "Platform", value: "cat_2" },
  ]);
  assert.deepEqual(retargetRule({ fieldKey: "categoryId", operator: "equals", value: "deleted_cat" }, category), {
    fieldKey: "categoryId",
    operator: "equals",
    value: "deleted_cat",
  });
  // An empty value still gets filled in, since that is the refusal case.
  assert.deepEqual(retargetRule({ fieldKey: "title", operator: "equals", value: "" }, category), {
    fieldKey: "categoryId",
    operator: "equals",
    value: "cat_1",
  });
});

test("an event with no categories keeps the category rule value as free text", () => {
  const sources = ruleSources([], null, { categoryId: [] });
  assert.equal(findRuleSource(sources, "categoryId")?.optionValues, null);
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
