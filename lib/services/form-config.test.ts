import assert from "node:assert/strict";
import test from "node:test";
import { findDuplicateFieldKeys, resolvePublicForm } from "@/lib/services/form-config";

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

test("resolvePublicForm prefers an exact id match over a slug match", () => {
  const candidates = [
    { id: "form-b", slug: "form-a" },
    { id: "form-a", slug: "call-for-speakers" },
  ];
  assert.equal(resolvePublicForm("form-a", candidates)?.id, "form-a");
});

test("resolvePublicForm falls back to the slug match", () => {
  const candidates = [{ id: "form-a", slug: "call-for-speakers" }];
  assert.equal(resolvePublicForm("call-for-speakers", candidates)?.id, "form-a");
});

test("resolvePublicForm is deterministic when a slug repeats across events", () => {
  const candidates = [
    { id: "form-z", slug: "call-for-speakers" },
    { id: "form-a", slug: "call-for-speakers" },
  ];
  assert.equal(resolvePublicForm("call-for-speakers", candidates)?.id, "form-a");
  assert.equal(
    resolvePublicForm("call-for-speakers", [...candidates].reverse())?.id,
    "form-a",
  );
});

test("resolvePublicForm returns null when nothing matches", () => {
  assert.equal(resolvePublicForm("missing", [{ id: "form-a", slug: "cfp" }]), null);
});
