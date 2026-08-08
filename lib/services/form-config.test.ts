import assert from "node:assert/strict";
import test from "node:test";
import { findDuplicateFieldKeys } from "@/lib/services/form-config";

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

