import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  isAssignmentEvaluatorRole,
  isAssignmentReviewable,
  lockReviewAssignmentWrite,
  sortAssignmentLockIds,
  type ReviewAssignmentWriteLockDependencies,
} from "./review-assignment-lock";
import { reviewAssignmentInputSchema } from "@/types/api";

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

/**
 * R4 — a repeated id is a duplicate request, not an invalid one.
 *
 * The route establishes scope by comparing a DB read's length against
 * `input.<ids>.length` at three points. Every one of those reads returns a
 * SET, so before the schema deduped, `["a", "a"]` came back as one row and the
 * admin was told their proposal was "not in this event" when it was. The
 * schema is the one place that can fix all three at once.
 */
test("R4: duplicate assignment ids are deduped in order, not refused", () => {
  const parsed = reviewAssignmentInputSchema.parse({
    planId: "plan-a",
    abstractIds: ["abstract-b", "abstract-a", "abstract-b"],
    evaluatorIds: ["user-z", "user-z", "user-a"],
  });
  // Order preserved on first appearance: it is the order the upserts run in.
  assert.deepEqual(parsed.abstractIds, ["abstract-b", "abstract-a"]);
  assert.deepEqual(parsed.evaluatorIds, ["user-z", "user-a"]);
});

test("R4: the deduped length is what the route's three scope comparisons see", () => {
  const parsed = reviewAssignmentInputSchema.parse({
    planId: "plan-a",
    abstractIds: ["abstract-a", "abstract-a", "abstract-a"],
    evaluatorIds: ["user-a", "user-a"],
  });
  // What a `findMany({ where: { id: { in: ... } } })` would return for this
  // input, i.e. exactly what each of the three `!==` comparisons is fed.
  const abstractRowsFromDb = [...new Set(parsed.abstractIds)];
  const evaluatorRowsFromDb = new Set(parsed.evaluatorIds);
  assert.equal(abstractRowsFromDb.length, parsed.abstractIds.length);
  assert.equal(evaluatorRowsFromDb.size, parsed.evaluatorIds.length);
  // And the upsert loop now runs once per pair rather than three times for one.
  assert.equal(parsed.abstractIds.length * parsed.evaluatorIds.length, 1);
});

test("R4: dedupe does not weaken the min(1) refusal or the id shape", () => {
  const empty = reviewAssignmentInputSchema.safeParse({
    planId: "plan-a",
    abstractIds: [],
    evaluatorIds: ["user-a"],
  });
  assert.equal(empty.success, false);
  // idSchema is min(1).max(191) and deliberately does NOT trim, so a blank
  // string is a valid id shape here; the bound is what dedupe must not relax.
  const oversize = reviewAssignmentInputSchema.safeParse({
    planId: "plan-a",
    abstractIds: ["a".repeat(192)],
    evaluatorIds: ["user-a"],
  });
  assert.equal(oversize.success, false);
});

test("R4: the route still derives its three scope checks from the parsed input", () => {
  const route = readFileSync(
    new URL("../../app/api/evaluations/assignments/route.ts", import.meta.url),
    "utf8",
  );
  // If any of these stopped reading `input.<ids>.length`, the schema dedupe
  // would no longer reach that comparison and R4 would come back at that site.
  assert.match(route, /scopedAbstracts\.length !== input\.abstractIds\.length/);
  assert.match(route, /abstracts\.length !== input\.abstractIds\.length/);
  assert.match(route, /validEvaluatorIds\.size !== input\.evaluatorIds\.length/);
  // And it must keep iterating the parsed arrays, so one pair is written once.
  assert.match(route, /for \(const evaluatorId of input\.evaluatorIds\)/);
});
