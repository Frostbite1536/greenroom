import assert from "node:assert/strict";
import test from "node:test";
import { observeBeforeDeadline } from "./smoke-deadline.mjs";

test("observeBeforeDeadline returns a completed value before its deadline", async () => {
  const observation = await observeBeforeDeadline(Promise.resolve(201), 50);
  assert.deepEqual(observation, { completed: true, value: 201 });
});

test("observeBeforeDeadline returns a bounded non-completion for a stalled probe", async () => {
  const observation = await observeBeforeDeadline(new Promise(() => {}), 5);
  assert.deepEqual(observation, { completed: false });
});
