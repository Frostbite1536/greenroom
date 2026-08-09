import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  isAssignmentEvaluatorRole,
  isAssignmentReviewable,
  lockReviewAssignmentWrite,
  sortAssignmentLockIds,
  type ReviewAssignmentWriteLockDependencies,
} from "./review-assignment-lock";

test("assignment writes lock plan, bytewise target members, then bytewise Abstracts", async () => {
  const calls: string[] = [];
  const dependencies: ReviewAssignmentWriteLockDependencies = {
    async lockPlan(_tx, planId) {
      calls.push(`plan:${planId}`);
      return { id: planId, eventId: "event-a" };
    },
    async lockMemberAuthorities(_tx, eventId, evaluatorIds) {
      calls.push(`member-keys:${eventId}:${evaluatorIds.join(",")}`);
    },
    async lockMembers(_tx, eventId, evaluatorIds) {
      calls.push(`members:${eventId}:${evaluatorIds.join(",")}`);
    },
    async lockAbstract(_tx, abstractId) {
      calls.push(`abstract:${abstractId}`);
    },
  };

  const result = await lockReviewAssignmentWrite(
    {} as Prisma.TransactionClient,
    {
      eventId: "event-a",
      planId: "plan-a",
      evaluatorIds: ["user-z", "user-a", "user-z"],
      abstractIds: ["abstract-z", "abstract-a"],
    },
    dependencies,
  );

  assert.deepEqual(result, { id: "plan-a", eventId: "event-a" });
  assert.deepEqual(calls, [
    "plan:plan-a",
    "member-keys:event-a:user-a,user-z",
    "members:event-a:user-a,user-z",
    "abstract:abstract-a",
    "abstract:abstract-z",
  ]);
});

test("foreign or missing plans stop before membership and Abstract locks", async () => {
  const calls: string[] = [];
  const dependencies: ReviewAssignmentWriteLockDependencies = {
    async lockPlan() {
      calls.push("plan");
      return { id: "plan-other", eventId: "event-other" };
    },
    async lockMemberAuthorities() { calls.push("member-keys"); },
    async lockMembers() { calls.push("members"); },
    async lockAbstract() { calls.push("abstract"); },
  };

  const result = await lockReviewAssignmentWrite(
    {} as Prisma.TransactionClient,
    { eventId: "event-a", planId: "plan-other", evaluatorIds: ["user-a"], abstractIds: ["abstract-a"] },
    dependencies,
  );

  assert.deepEqual(result, { id: "plan-other", eventId: "event-other" });
  assert.deepEqual(calls, ["plan"]);
});

test("reviewer authority permits only event evaluators and admins", () => {
  assert.equal(isAssignmentEvaluatorRole("EVALUATOR"), true);
  assert.equal(isAssignmentEvaluatorRole("ADMIN"), true);
  assert.equal(isAssignmentEvaluatorRole("SPEAKER"), false);
});

test("only undecided submitted and under-review proposals can receive assignments", () => {
  assert.equal(isAssignmentReviewable({ status: "SUBMITTED", decidedAt: null }), true);
  assert.equal(isAssignmentReviewable({ status: "UNDER_REVIEW", decidedAt: null }), true);
  for (const status of ["DRAFT", "MAYBE", "ACCEPTED", "REJECTED", "WITHDRAWN"] as const) {
    assert.equal(isAssignmentReviewable({ status, decidedAt: null }), false, status);
  }
  assert.equal(isAssignmentReviewable({ status: "SUBMITTED", decidedAt: new Date("2026-08-09T00:00:00Z") }), false);
});

test("assignment lock ordering is stable and de-duplicates only for locking", () => {
  assert.deepEqual(sortAssignmentLockIds(["id-9", "id-1", "id-9", "id-2"]), ["id-1", "id-2", "id-9"]);
});
