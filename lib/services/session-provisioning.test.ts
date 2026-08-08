import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SESSION_MINUTES,
  planTaskAssignments,
  resolveSessionDuration,
} from "@/lib/services/session-provisioning";

test("an explicit duration wins over the proposal", () => {
  assert.equal(resolveSessionDuration(45, 60), 60);
});

test("the proposal's duration is used when the caller does not ask for one", () => {
  assert.equal(resolveSessionDuration(45), 45);
  assert.equal(resolveSessionDuration(45, null), 45);
});

test("accepting never fails because the proposal omitted a duration", () => {
  assert.equal(resolveSessionDuration(null), DEFAULT_SESSION_MINUTES);
  assert.equal(resolveSessionDuration(undefined, null), DEFAULT_SESSION_MINUTES);
});

test("zero is a real requested duration, not a missing one", () => {
  // Guards against a `||` fallback creeping in: the schema floor is 5, so 0
  // should surface as itself and be rejected upstream rather than silently
  // becoming 30.
  assert.equal(resolveSessionDuration(45, 0), 0);
});

test("every speaker gets every task", () => {
  const pairs = planTaskAssignments(["task-1", "task-2"], ["user-a", "user-b"]);
  assert.equal(pairs.length, 4);
  assert.deepEqual(pairs, [
    { taskId: "task-1", userId: "user-a" },
    { taskId: "task-1", userId: "user-b" },
    { taskId: "task-2", userId: "user-a" },
    { taskId: "task-2", userId: "user-b" },
  ]);
});

test("a speaker listed twice is only assigned once", () => {
  const pairs = planTaskAssignments(["task-1"], ["user-a", "user-a"]);
  assert.deepEqual(pairs, [{ taskId: "task-1", userId: "user-a" }]);
});

test("an event with no checklist, or a talk with no speakers, assigns nothing", () => {
  assert.deepEqual(planTaskAssignments([], ["user-a"]), []);
  assert.deepEqual(planTaskAssignments(["task-1"], []), []);
});

test("the plan is stable across retries", () => {
  const once = planTaskAssignments(["t1", "t2"], ["u1", "u2"]);
  const twice = planTaskAssignments(["t1", "t2"], ["u1", "u2"]);
  assert.deepEqual(once, twice);
});
