import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AbstractStatus } from "@prisma/client";
import { abstractDecisionSchema } from "@/types/api";
import { ABSTRACT_DECISION_REFUSALS } from "@/lib/services/abstract-decision-write";
import {
  ABSTRACT_DECISIONS,
  bulkDecisionEligibility,
  canAdminDecide,
  decisionProvisionsSession,
  decisionTimestamp,
  maybeBlockedByConfirmedSession,
  sessionPublicationForDecision,
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

test("MAYBE is refused after a Session becomes confirmed", () => {
  assert.equal(maybeBlockedByConfirmedSession("MAYBE", true), true);
  assert.equal(maybeBlockedByConfirmedSession("MAYBE", false), false);
  assert.equal(maybeBlockedByConfirmedSession("ACCEPTED", true), false);
  assert.equal(maybeBlockedByConfirmedSession("REJECTED", true), false);
});

test("rejecting an accepted proposal takes its talk off the public programme", () => {
  // The leak: nothing is deleted on reversal, so before this the rejected
  // talk's Session stayed scheduled and publicly announced.
  assert.equal(sessionPublicationForDecision("REJECTED"), "DRAFT");
});

test("accepting puts the talk on the programme, so a reversal is reversible", () => {
  assert.equal(sessionPublicationForDecision("ACCEPTED"), "PUBLISHED");
});

test("MAYBE says nothing about publication", () => {
  // A review state is not a publication instruction, and MAYBE cannot coexist
  // with a Session in the first place.
  assert.equal(sessionPublicationForDecision("MAYBE"), null);
});

test("G7: bulk decides only what is still awaiting a decision, and names the rest", () => {
  // The single-row route deliberately allows a re-decision — the drawer gates
  // that behind an explicit "Change decision" click on one named proposal. A
  // tick box carries no such evidence, so a selection that happens to include a
  // declined proposal must not silently reverse it.
  assert.equal(bulkDecisionEligibility("SUBMITTED"), "ELIGIBLE");
  assert.equal(bulkDecisionEligibility("UNDER_REVIEW"), "ELIGIBLE");

  // Already decided, in all three directions. MAYBE counts: it is a stored
  // outcome someone chose, not an absence of one.
  assert.equal(bulkDecisionEligibility("ACCEPTED"), "ABSTRACT_ALREADY_DECIDED");
  assert.equal(bulkDecisionEligibility("MAYBE"), "ABSTRACT_ALREADY_DECIDED");
  assert.equal(bulkDecisionEligibility("REJECTED"), "ABSTRACT_ALREADY_DECIDED");

  // Withdrawal is final for every writer (INV-WITHDRAW-001), and it reports
  // under its own name so the skip list says what actually happened.
  assert.equal(bulkDecisionEligibility("WITHDRAWN"), "ABSTRACT_WITHDRAWN");
  // A draft was never submitted, so there is nothing to decide on it.
  assert.equal(bulkDecisionEligibility("DRAFT"), "ABSTRACT_NOT_SUBMITTED");
});

test("G7: the awaiting-a-decision set is exactly what the drawer offers buttons for", () => {
  // The drawer's own gate is `status === "UNDER_REVIEW" || status === "SUBMITTED"`
  // before "Change decision" is pressed. If these two ever disagree, a bulk
  // action becomes reachable for a row whose drawer refuses it, or the reverse.
  const drawerUndecided: AbstractStatus[] = ["SUBMITTED", "UNDER_REVIEW"];
  const every: AbstractStatus[] = [
    "DRAFT", "SUBMITTED", "UNDER_REVIEW", "MAYBE", "ACCEPTED", "REJECTED", "WITHDRAWN",
  ];
  for (const status of every) {
    assert.equal(
      bulkDecisionEligibility(status) === "ELIGIBLE",
      drawerUndecided.includes(status),
      status,
    );
  }
  const table = readFileSync(new URL("../../components/abstracts-table.tsx", import.meta.url), "utf8");
  assert.match(table, /const undecided = status === "UNDER_REVIEW" \|\| status === "SUBMITTED";/);
});

test("G7: every refusal the decision writer can return carries a status and a message", () => {
  // Both callers read this table: the single-row route raises it as an
  // ApiError, the bulk route turns the same code into a named skip. A code with
  // no message would reach an operator as an empty skip reason.
  for (const [code, refusal] of Object.entries(ABSTRACT_DECISION_REFUSALS)) {
    assert.ok(refusal.status >= 400 && refusal.status < 500, `${code} has status ${refusal.status}`);
    assert.ok(refusal.message.trim().length > 0, `${code} has no message`);
  }
  // The three the single-row route has always raised keep their exact statuses
  // and wording; this route's contract did not change when the write moved.
  assert.deepEqual(ABSTRACT_DECISION_REFUSALS.ABSTRACT_NOT_FOUND, {
    status: 404,
    message: "Abstract not found.",
  });
  assert.deepEqual(ABSTRACT_DECISION_REFUSALS.ABSTRACT_WITHDRAWN, {
    status: 409,
    message: "This abstract has been withdrawn.",
  });
  assert.deepEqual(ABSTRACT_DECISION_REFUSALS.MAYBE_NOT_AVAILABLE, {
    status: 409,
    message: "Maybe is only available before a proposal becomes a confirmed Session.",
  });
  // And every eligibility verdict other than ELIGIBLE is a refusal code, so the
  // bulk gate cannot produce a verdict with no copy behind it.
  for (const status of ["ACCEPTED", "WITHDRAWN", "DRAFT"] as AbstractStatus[]) {
    const verdict = bulkDecisionEligibility(status);
    assert.notEqual(verdict, "ELIGIBLE");
    assert.ok(verdict in ABSTRACT_DECISION_REFUSALS, `${verdict} has no refusal entry`);
  }
});
