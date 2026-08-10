import assert from "node:assert/strict";
import test from "node:test";
import { embedAliasTarget } from "@/lib/embed-alias";

test("an alias without an event redirects to the canonical embed path", () => {
  assert.equal(embedAliasTarget("/embed/schedule"), "/embed/schedule");
  assert.equal(embedAliasTarget("/embed/speakers", undefined), "/embed/speakers");
});

test("an explicit event is carried through and encoded", () => {
  assert.equal(embedAliasTarget("/embed/schedule", "forward 2026"), "/embed/schedule?event=forward%202026");
  assert.equal(embedAliasTarget("/embed/speakers", "a&b"), "/embed/speakers?event=a%26b");
});

test("a blank event is treated as absent rather than an empty filter", () => {
  assert.equal(embedAliasTarget("/embed/schedule", "   "), "/embed/schedule");
  assert.equal(embedAliasTarget("/embed/speakers", ""), "/embed/speakers");
});
