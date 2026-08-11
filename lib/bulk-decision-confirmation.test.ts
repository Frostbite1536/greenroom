import assert from "node:assert/strict";
import test from "node:test";
import {
  BULK_DECISION_NO_EMAIL_SENTENCE,
  BULK_DECISION_NO_EMAIL_SENTENCE_PAST,
  bulkDecisionActionLabel,
  bulkDecisionPromptBody,
  bulkDecisionPromptSkipNotice,
  bulkDecisionPromptTitle,
  bulkDecisionSummary,
  confirmedSessionCount,
  proposalCount,
} from "@/lib/bulk-decision-confirmation";
import type { BulkDecisionReport } from "@/lib/services/bulk-abstract-decision";

const report = (over: Partial<BulkDecisionReport> = {}): BulkDecisionReport => ({
  decision: "ACCEPTED",
  requested: 3,
  decided: 3,
  skipped: 0,
  sessionsCreated: 3,
  tasksAssigned: 9,
  results: [],
  ...over,
});

test("the confirm dialog states the consequence before the click, with the count", () => {
  // The roadmap item is "preview-safe bulk decisions" and this is the sentence
  // the whole feature turns on: the operator is told what is built and that
  // nothing is mailed, before they commit to it.
  assert.equal(
    bulkDecisionPromptBody({ decision: "ACCEPTED", eligible: 12, ineligible: 0 }),
    "Accept 12 proposals — this creates 12 confirmed sessions and assigns onboarding tasks. " +
      "No emails are sent; decision emails remain preview-gated in Operations.",
  );
  assert.equal(bulkDecisionPromptTitle({ decision: "ACCEPTED", eligible: 12, ineligible: 0 }), "Accept 12 proposals?");
});

test("every bulk prompt and every bulk result carries the no-email sentence", () => {
  // The one claim an operator cannot verify for themselves after the fact, and
  // the one they most need: a hundred decisions is a hundred speakers who did
  // NOT just get mail. It must appear on all three actions, both tenses.
  for (const decision of ["ACCEPTED", "MAYBE", "REJECTED"] as const) {
    const body = bulkDecisionPromptBody({ decision, eligible: 4, ineligible: 0 });
    assert.ok(body.includes(BULK_DECISION_NO_EMAIL_SENTENCE), decision);
    const summary = bulkDecisionSummary(report({ decision, decided: 4, sessionsCreated: 4 }));
    assert.ok(summary.includes(BULK_DECISION_NO_EMAIL_SENTENCE_PAST), decision);
  }
  // And it names where sending actually lives, rather than only forbidding it.
  assert.match(BULK_DECISION_NO_EMAIL_SENTENCE, /preview-gated in Operations\.$/);
  assert.match(BULK_DECISION_NO_EMAIL_SENTENCE_PAST, /preview-gated in Operations\.$/);
});

test("only accepting claims to build anything", () => {
  const maybe = bulkDecisionPromptBody({ decision: "MAYBE", eligible: 5, ineligible: 0 });
  assert.match(maybe, /^Mark 5 proposals as maybe — no sessions are created/);
  assert.match(maybe, /no speaker onboarding tasks are assigned/);

  const decline = bulkDecisionPromptBody({ decision: "REJECTED", eligible: 5, ineligible: 0 });
  assert.match(decline, /^Decline 5 proposals — no sessions are created/);
  // Nothing is ever deleted by a decision (INV-DOMAIN-001), so a decline must
  // not imply the batch removed anything from the programme.
  assert.match(decline, /nothing is removed from the programme/);
});

test("a selection with ineligible rows says so before the click, not only after", () => {
  assert.equal(bulkDecisionPromptSkipNotice({ decision: "ACCEPTED", eligible: 8, ineligible: 0 }), null);

  const one = bulkDecisionPromptSkipNotice({ decision: "ACCEPTED", eligible: 8, ineligible: 1 });
  assert.match(one ?? "", /^1 proposal in this selection is skipped/);
  const many = bulkDecisionPromptSkipNotice({ decision: "ACCEPTED", eligible: 8, ineligible: 4 });
  assert.match(many ?? "", /^4 proposals in this selection are skipped/);
  assert.match(many ?? "", /only change proposals still awaiting a decision/);

  // The heading and body count the rows that will be WRITTEN, so the arithmetic
  // an operator reads is the arithmetic the server performs.
  assert.equal(bulkDecisionPromptTitle({ decision: "ACCEPTED", eligible: 8, ineligible: 4 }), "Accept 8 proposals?");
  assert.match(bulkDecisionPromptBody({ decision: "ACCEPTED", eligible: 8, ineligible: 4 }), /creates 8 confirmed sessions/);
});

test("the result names what the server actually did, not what the prompt promised", () => {
  assert.equal(
    bulkDecisionSummary(report({ decided: 12, sessionsCreated: 12, tasksAssigned: 36, skipped: 0 })),
    "Accepted 12 proposals. 12 confirmed sessions and 36 speaker onboarding tasks were created. " +
      "No emails were sent; decision emails remain preview-gated in Operations.",
  );
  // An event with no onboarding checklist assigns nothing, and must not be
  // reported as if it had — the single-row confirmation makes the same
  // distinction, for the same reason.
  assert.match(
    bulkDecisionSummary(report({ decided: 2, sessionsCreated: 2, tasksAssigned: 0 })),
    /No speaker onboarding tasks were added, because this event has no onboarding checklist yet\./,
  );
  // Skips are counted in the summary and pointed at the list beneath it.
  assert.match(
    bulkDecisionSummary(report({ decided: 2, skipped: 3, sessionsCreated: 2, tasksAssigned: 4 })),
    /3 proposals skipped — see the list below\./,
  );
});

test("a batch that wrote nothing never reads as success", () => {
  // The all-already-decided selection. "Accepted 0 proposals" would be a lie of
  // tone even though the number is right.
  const nothing = bulkDecisionSummary(report({ decided: 0, skipped: 3, sessionsCreated: 0, tasksAssigned: 0 }));
  assert.match(nothing, /^Nothing was changed\./);
  assert.equal(/^Accepted/.test(nothing), false);
  assert.match(nothing, /3 proposals skipped/);
  assert.ok(nothing.includes(BULK_DECISION_NO_EMAIL_SENTENCE_PAST));
});

test("maybe and decline results never claim a session or a task", () => {
  for (const decision of ["MAYBE", "REJECTED"] as const) {
    const summary = bulkDecisionSummary(
      report({ decision, decided: 6, sessionsCreated: 0, tasksAssigned: 0 }),
    );
    assert.match(summary, /No sessions and no speaker onboarding tasks were created\./);
    // Never a counted session or task: those phrases exist only on the accept
    // branch, so a copy edit that leaked one here would be caught rather than
    // silently telling an organizer a decline had built talks.
    assert.equal(/confirmed session/.test(summary), false, decision);
    // No COUNTED task either: "no speaker onboarding tasks" is the whole point,
    // so a number in front of that noun would be the leak worth catching.
    assert.equal(/\d+ speaker onboarding task/.test(summary), false, decision);
  }
  assert.match(bulkDecisionSummary(report({ decision: "MAYBE", decided: 6 })), /^Marked as maybe 6 proposals\./);
  assert.match(bulkDecisionSummary(report({ decision: "REJECTED", decided: 1 })), /^Declined 1 proposal\./);
});

test("counting is singular at one and never negative", () => {
  assert.equal(proposalCount(1), "1 proposal");
  assert.equal(proposalCount(0), "0 proposals");
  assert.equal(proposalCount(2), "2 proposals");
  assert.equal(proposalCount(-3), "0 proposals");
  assert.equal(confirmedSessionCount(1), "1 confirmed session");
  assert.equal(confirmedSessionCount(9), "9 confirmed sessions");
});

test("the action labels are the drawer's own vocabulary", () => {
  // "Decline", not "Reject": the stored status is REJECTED but every organizer
  // surface says Declined (`ABSTRACT_STATUS_META`), and a bulk button that
  // disagreed with the pill it produces would read as a different action.
  assert.equal(bulkDecisionActionLabel("ACCEPTED"), "Accept");
  assert.equal(bulkDecisionActionLabel("MAYBE"), "Maybe");
  assert.equal(bulkDecisionActionLabel("REJECTED"), "Decline");
});
