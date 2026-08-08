import assert from "node:assert/strict";
import test from "node:test";
import {
  answerOptionValues,
  describeDestructiveChange,
  findDestructiveFieldChanges,
  findDuplicateFieldKeys,
} from "@/lib/services/form-config";

test("findDuplicateFieldKeys returns nothing for distinct keys", () => {
  assert.deepEqual(findDuplicateFieldKeys([{ key: "title" }, { key: "bio" }]), []);
});

test("findDuplicateFieldKeys reports each repeated key once, in first-seen order", () => {
  const duplicates = findDuplicateFieldKeys([
    { key: "bio" },
    { key: "title" },
    { key: "bio" },
    { key: "title" },
    { key: "bio" },
  ]);
  assert.deepEqual(duplicates, ["bio", "title"]);
});


// --- B5: protecting answers that already exist (audit2#1) -------------------

const storedFields = [
  { key: "title_note", type: "SHORT_TEXT", options: null },
  { key: "audience", type: "SELECT", options: [{ value: "beginner" }, { value: "advanced" }] },
];

test("an unchanged form reports no destructive changes", () => {
  assert.deepEqual(findDestructiveFieldChanges(storedFields, storedFields), []);
});

test("label, help and required edits are not destructive", () => {
  // Only key/type/options participate; everything else is free to edit.
  const relabelled = [
    { key: "title_note", type: "SHORT_TEXT", options: null },
    { key: "audience", type: "SELECT", options: [{ value: "beginner" }, { value: "advanced" }] },
  ];
  assert.deepEqual(findDestructiveFieldChanges(storedFields, relabelled), []);
});

test("removing a question is destructive", () => {
  const changes = findDestructiveFieldChanges(storedFields, [storedFields[0]]);
  assert.deepEqual(changes, [{ kind: "removed", key: "audience" }]);
});

test("renaming a key reads as a removal, because that is what it does to answers", () => {
  const renamed = [{ key: "talk_note", type: "SHORT_TEXT", options: null }, storedFields[1]];
  assert.deepEqual(findDestructiveFieldChanges(storedFields, renamed), [
    { kind: "removed", key: "title_note" },
  ]);
});

test("changing a field's type is destructive", () => {
  const retyped = [{ key: "title_note", type: "NUMBER", options: null }, storedFields[1]];
  assert.deepEqual(findDestructiveFieldChanges(storedFields, retyped), [
    { kind: "retyped", key: "title_note", from: "SHORT_TEXT", to: "NUMBER" },
  ]);
});

test("dropping an option is destructive, adding one is not", () => {
  const dropped = [storedFields[0], { key: "audience", type: "SELECT", options: [{ value: "beginner" }] }];
  assert.deepEqual(findDestructiveFieldChanges(storedFields, dropped), [
    { kind: "optionsRemoved", key: "audience", removed: ["advanced"] },
  ]);

  const added = [
    storedFields[0],
    { key: "audience", type: "SELECT", options: [{ value: "beginner" }, { value: "advanced" }, { value: "expert" }] },
  ];
  assert.deepEqual(findDestructiveFieldChanges(storedFields, added), []);
});

test("a brand-new field in the payload is not a change to anything stored", () => {
  const withNew = [...storedFields, { key: "brand_new", type: "SHORT_TEXT", options: null }];
  assert.deepEqual(findDestructiveFieldChanges(storedFields, withNew), []);
});

test("answerOptionValues reads single and multi answers, ignoring other shapes", () => {
  assert.deepEqual(answerOptionValues("advanced"), ["advanced"]);
  assert.deepEqual(answerOptionValues(["ai", "community"]), ["ai", "community"]);
  assert.deepEqual(answerOptionValues(""), []);
  assert.deepEqual(answerOptionValues(null), []);
  assert.deepEqual(answerOptionValues(42), []);
  assert.deepEqual(answerOptionValues(["ai", 7]), ["ai"]);
});

test("refusal copy names the question and stays free of jargon", () => {
  const message = describeDestructiveChange({ kind: "removed", key: "audience" }, "Audience level", 3);
  assert.ok(message.includes("Audience level"));
  assert.ok(message.includes("3 submissions have"));
  assert.ok(!/[A-Z_]{4,}/.test(message), "must not leak an error code");

  const single = describeDestructiveChange({ kind: "retyped", key: "a", from: "SHORT_TEXT", to: "NUMBER" }, "Bio", 1);
  assert.ok(single.includes("1 submission has"));
});
