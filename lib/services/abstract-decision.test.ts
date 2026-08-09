import assert from "node:assert/strict";
import test from "node:test";
import type { AbstractStatus } from "@prisma/client";
import { abstractDecisionSchema } from "@/types/api";
import {
  ABSTRACT_DECISIONS,
  canAdminDecide,
  decisionProvisionsSession,
  decisionTimestamp,
} from "@/lib/services/abstract-decision";

test("the decision contract accepts approve, maybe, and deny only", () => {
  for (const decision of ABSTRACT_DECISIONS) {
    assert.equal(abstractDecisionSchema.safeParse({ abstractId: "abstract-1", decision }).success, true);
  }
  for (const decision of ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "WITHDRAWN", "nope"]) {
    assert.equal(abstractDecisionSchema.safeParse({ abstractId: "abstract-1", decision }).success, false);
  }
});

test("MAYBE is re-decidable while withdrawal remains final", () => {
  const nonTerminal: AbstractStatus[] = [
    "DRAFT", "SUBMITTED", "UNDER_REVIEW", "MAYBE", "ACCEPTED", "REJECTED",
  ];
  for (const status of nonTerminal) assert.equal(canAdminDecide(status), true, status);
  assert.equal(canAdminDecide("WITHDRAWN"), false);
});

test("only acceptance provisions a confirmed session and onboarding tasks", () => {
  assert.equal(decisionProvisionsSession("ACCEPTED"), true);
  assert.equal(decisionProvisionsSession("MAYBE"), false);
  assert.equal(decisionProvisionsSession("REJECTED"), false);
});

test("MAYBE clears the final-decision timestamp while final choices stamp it", () => {
  const now = new Date("2026-08-09T12:00:00.000Z");
  assert.equal(decisionTimestamp("MAYBE", now), null);
  assert.equal(decisionTimestamp("ACCEPTED", now), now);
  assert.equal(decisionTimestamp("REJECTED", now), now);
});
