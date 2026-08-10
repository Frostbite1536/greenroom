import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import {
  decideOnboardingTaskDeletion,
  startedTaskAssignmentWhere,
} from "@/lib/services/onboarding-task-deletion";

test("a template nobody has touched can be removed", () => {
  assert.deepEqual(decideOnboardingTaskDeletion(0), { allowed: true });
});

test("a single started assignment refuses deletion with a stable code", () => {
  const decision = decideOnboardingTaskDeletion(1);
  assert.equal(decision.allowed, false);
  if (decision.allowed) return;
  assert.equal(decision.code, "TASK_HAS_RESPONSES");
  assert.match(decision.message, /cannot be deleted/i);
  // The refusal must tell the organizer the history survived — S15's contract
  // is "preserve and explain", not "refuse and leave them guessing".
  assert.match(decision.message, /kept/i);
});

test("the refusal does not soften as more speakers are involved", () => {
  for (const started of [1, 2, 500]) {
    const decision = decideOnboardingTaskDeletion(started);
    assert.equal(decision.allowed, false, `started=${started}`);
  }
});

test("every column a speaker can write counts as work in progress", () => {
  const where = startedTaskAssignmentWhere("task-1");
  assert.equal(where.taskId, "task-1");
  const clauses = where.OR;
  assert.ok(Array.isArray(clauses));
  const keys = clauses.flatMap((clause) => Object.keys(clause));
  // A status-only predicate would cascade a half-filled task form away while
  // the assignment is still TODO, so `responses` in particular must be here.
  for (const column of ["status", "responses", "artifactUrl", "notes", "completedAt"]) {
    assert.ok(keys.includes(column), `missing ${column}`);
  }
});

test("the nullable Json column is compared with DbNull, not a bare null", () => {
  const clauses = startedTaskAssignmentWhere("task-1").OR;
  assert.ok(Array.isArray(clauses));
  const responses = clauses.find((clause) => "responses" in clause) as
    | { responses?: { not?: unknown } }
    | undefined;
  // `{ responses: { not: null } }` is not the same query on a `Json?` column:
  // Prisma needs DbNull to mean "the database NULL" there.
  assert.equal(responses?.responses?.not, Prisma.DbNull);
});

test("an untouched TODO assignment is not treated as speaker work", () => {
  const clauses = startedTaskAssignmentWhere("task-1").OR;
  assert.ok(Array.isArray(clauses));
  const status = clauses.find((clause) => "status" in clause) as
    | { status?: { not?: unknown } }
    | undefined;
  assert.deepEqual(status?.status, { not: "TODO" });
});
