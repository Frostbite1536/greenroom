import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONFLICT_DECLINABLE_STATUSES,
  RESTORABLE_ASSIGNMENT_STATUSES,
  canDeclareConflict,
  conflictDeclineRefusal,
  isActiveQueueAssignment,
  isDeclaredConflict,
  isRestoredByReassignment,
  scoreWriteRefusal,
  type ReviewAssignmentStatus,
} from "./review-conflict";

const ALL_STATUSES: ReviewAssignmentStatus[] = ["ASSIGNED", "IN_PROGRESS", "COMPLETED", "DECLINED"];

test("open review work can be stepped back from", () => {
  for (const status of CONFLICT_DECLINABLE_STATUSES) {
    assert.equal(conflictDeclineRefusal(status, false), null, status);
    assert.equal(canDeclareConflict(status, false), true, status);
  }
});

test("a submitted review is refused rather than silently unpicked", () => {
  // admin-decision-summary aggregates scores only from COMPLETED assignments,
  // so flipping a finished review to DECLINED would drop scores that already
  // counted. The refusal names the operator action that would be needed.
  const refusal = conflictDeclineRefusal("COMPLETED", false);
  assert.equal(refusal?.status, 409);
  assert.equal(refusal?.code, "REVIEW_ALREADY_SUBMITTED");
  assert.match(refusal?.message ?? "", /Ask an admin/);
  assert.equal(canDeclareConflict("COMPLETED", false), false);
});

test("declaring the same conflict twice is refused, not counted twice", () => {
  const refusal = conflictDeclineRefusal("DECLINED", false);
  assert.equal(refusal?.status, 409);
  assert.equal(refusal?.code, "CONFLICT_ALREADY_DECLARED");
  assert.equal(canDeclareConflict("DECLINED", false), false);
});

test("a withdrawn proposal answers with the same refusal the score route gives", () => {
  for (const status of ALL_STATUSES) {
    const refusal = conflictDeclineRefusal(status, true);
    assert.equal(refusal?.status, 409, status);
    assert.equal(refusal?.code, "ABSTRACT_WITHDRAWN", status);
    assert.equal(
      refusal?.message,
      "The speaker withdrew this proposal, so it no longer needs a review.",
      status,
    );
    assert.equal(canDeclareConflict(status, true), false, status);
  }
});

test("the control and the server refusal are the same rule, never two", () => {
  for (const status of ALL_STATUSES) {
    for (const withdrawn of [false, true]) {
      assert.equal(
        canDeclareConflict(status, withdrawn),
        conflictDeclineRefusal(status, withdrawn) === null,
        `${status} withdrawn=${withdrawn}`,
      );
    }
  }
});

test("a declined assignment leaves the active queue while completed work stays in it", () => {
  assert.equal(isActiveQueueAssignment("DECLINED", false), false);
  assert.equal(isActiveQueueAssignment("COMPLETED", false), true);
  assert.equal(isActiveQueueAssignment("ASSIGNED", false), true);
  assert.equal(isActiveQueueAssignment("IN_PROGRESS", false), true);
  // A withdrawn proposal already left the queue under C6 and stays out.
  for (const status of ALL_STATUSES) {
    assert.equal(isActiveQueueAssignment(status, true), false, status);
  }
});

test("a score write on a declared conflict is refused with a stable code", () => {
  // The declaration must survive a score write, racing or not: before this rule
  // the score route checked the abstract's status but never the assignment's,
  // so a DECLINED row could be scored straight back to COMPLETED.
  const refusal = scoreWriteRefusal("DECLINED");
  assert.equal(refusal?.status, 409);
  assert.equal(refusal?.code, "ASSIGNMENT_DECLINED");
  assert.match(refusal?.message ?? "", /Ask an admin to reassign it/);
});

test("score writes on every other assignment status are untouched by the new refusal", () => {
  for (const status of ["ASSIGNED", "IN_PROGRESS", "COMPLETED"] as ReviewAssignmentStatus[]) {
    assert.equal(scoreWriteRefusal(status), null, status);
  }
});

test("the score refusal and the decline refusal are different situations", () => {
  // Declining an already-declined row and scoring one are both 409s, but a
  // reviewer must not meet the wrong explanation for what they just did.
  assert.notEqual(
    scoreWriteRefusal("DECLINED")?.code,
    conflictDeclineRefusal("DECLINED", false)?.code,
  );
});

test("re-assignment restores a declined row and nothing else", () => {
  assert.deepEqual([...RESTORABLE_ASSIGNMENT_STATUSES], ["DECLINED"]);
  assert.equal(isRestoredByReassignment("DECLINED"), true);
  // COMPLETED is the load-bearing exclusion: admin-decision-summary reads only
  // completed assignments, so resetting one would strip a real review out of
  // the decision aggregate.
  assert.equal(isRestoredByReassignment("COMPLETED"), false);
  assert.equal(isRestoredByReassignment("ASSIGNED"), false);
  assert.equal(isRestoredByReassignment("IN_PROGRESS"), false);
});

test("restoration is the exact inverse of what a declaration may consume", () => {
  // Only a row that could be declined can ever need restoring, so the two sets
  // must stay in step: every declinable status becomes DECLINED, and DECLINED
  // is the only status restoration touches.
  for (const status of CONFLICT_DECLINABLE_STATUSES) {
    assert.equal(isRestoredByReassignment(status), false, status);
  }
  assert.equal(isRestoredByReassignment("DECLINED"), true);
});

test("a declined row is named a conflict only when the proposal still stands", () => {
  // DECLINED has two writers: the C6 withdrawal path, which also marks the
  // abstract WITHDRAWN, and this feature. Only the latter is a conflict.
  assert.equal(isDeclaredConflict("DECLINED", false), true);
  assert.equal(isDeclaredConflict("DECLINED", true), false);
  assert.equal(isDeclaredConflict("COMPLETED", false), false);
  assert.equal(isDeclaredConflict("ASSIGNED", false), false);
});
