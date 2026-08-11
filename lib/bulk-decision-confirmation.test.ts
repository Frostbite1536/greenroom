import assert from "node:assert/strict";
import test from "node:test";
import {
  BULK_DECISION_NO_EMAIL_SENTENCE,
  BULK_DECISION_NO_EMAIL_SENTENCE_PAST,
  bulkDecisionActionLabel,
  bulkDecisionNothingEligibleNotice,
  bulkDecisionPromptBody,
  bulkDecisionPromptSkipNotice,
  bulkDecisionPromptTitle,
  bulkDecisionRequestBody,
  bulkDecisionSkipGroups,
  bulkDecisionSummary,
  confirmedSessionCount,
  proposalCount,
} from "@/lib/bulk-decision-confirmation";
import { bulkDecisionEligibility } from "@/lib/services/abstract-decision";
import type { AbstractStatus } from "@prisma/client";
import {
  BULK_DECISION_SKIP_REASONS,
  runBulkAbstractDecision,
} from "@/lib/services/bulk-abstract-decision";
import type { BulkDecisionReport } from "@/lib/services/bulk-abstract-decision";
import type { AbstractDecisionWriteResult } from "@/lib/services/abstract-decision-write";
import { OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import { BULK_ABSTRACT_DECISION_LIMIT } from "@/types/api";

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
  assert.match(decline, /nothing is removed from the program/);
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

/**
 * A selection as the table hands it to the bar, and the batch it produces.
 *
 * `decideOne` refuses exactly what the server refuses — `bulkDecisionEligibility`
 * is the same predicate `writeAbstractDecision` runs under the row's lock — so
 * driving the real `runBulkAbstractDecision` over the real request body proves
 * the round trip an operator actually gets, rather than a hand-built report.
 */
const selection = (rows: readonly [string, AbstractStatus][]) =>
  rows.map(([id, status]) => ({ id, status, title: `Proposal ${id}` }));

async function runSelection(
  decision: "ACCEPTED" | "MAYBE" | "REJECTED",
  rows: readonly { id: string; status: AbstractStatus }[],
) {
  const body = bulkDecisionRequestBody(decision, rows);
  const statuses = new Map(rows.map((row) => [row.id, row.status]));
  const report = await runBulkAbstractDecision(decision, body.abstractIds, async (abstractId) => {
    const status = statuses.get(abstractId);
    const verdict = status ? bulkDecisionEligibility(status) : "ABSTRACT_NOT_FOUND";
    if (verdict !== "ELIGIBLE") return { decided: false, refusal: verdict };
    return {
      decided: true,
      decision,
      sessionId: `session-${abstractId}`,
      sessionCreated: decision === "ACCEPTED",
      tasksAssigned: decision === "ACCEPTED" ? 2 : 0,
      topicReconciled: false,
      summaryReconciled: false,
    } satisfies AbstractDecisionWriteResult;
  });
  return { body, report };
}

test("a mixed selection posts every ticked id, not just the eligible ones", async () => {
  // The defect this pins: filtering to ELIGIBLE before the POST. It looks
  // harmless — the server would have skipped those rows anyway — but it turns a
  // named skip into no answer at all, and an operator who ticked six rows and
  // reads five outcomes cannot tell the sixth from a silent failure.
  const rows = selection([
    ["a", "SUBMITTED"],
    ["b", "ACCEPTED"],
    ["c", "UNDER_REVIEW"],
    ["d", "WITHDRAWN"],
    ["e", "DRAFT"],
    ["f", "SUBMITTED"],
  ]);
  const { body, report } = await runSelection("ACCEPTED", rows);

  // The outbound list IS the selection: same ids, same order, nothing dropped.
  assert.deepEqual(body.abstractIds, ["a", "b", "c", "d", "e", "f"]);
  assert.deepEqual(body.abstractIds, rows.map((row) => row.id));
  const eligibleOnly = rows.filter((row) => bulkDecisionEligibility(row.status) === "ELIGIBLE");
  assert.equal(eligibleOnly.length, 3);
  assert.notDeepEqual(body.abstractIds, eligibleOnly.map((row) => row.id));

  // And the server answers for all six, exactly once each.
  assert.equal(report.requested, 6);
  assert.deepEqual(report.results.map((item) => item.abstractId), body.abstractIds);
  assert.equal(report.decided, 3);
  assert.equal(report.skipped, 3);

  // Every skipped row is named, with its own reason — not one bucket of "other".
  const groups = bulkDecisionSkipGroups(report, new Map(rows.map((r) => [r.id, r.title])));
  assert.deepEqual(
    groups.map((group) => [group.reasonCode, group.ids, group.reason]),
    [
      ["ABSTRACT_ALREADY_DECIDED", ["b"], BULK_DECISION_SKIP_REASONS.ABSTRACT_ALREADY_DECIDED],
      ["ABSTRACT_WITHDRAWN", ["d"], BULK_DECISION_SKIP_REASONS.ABSTRACT_WITHDRAWN],
      ["ABSTRACT_NOT_SUBMITTED", ["e"], BULK_DECISION_SKIP_REASONS.ABSTRACT_NOT_SUBMITTED],
    ],
  );
  // Named by the title the operator ticked, where the selection knows it.
  assert.deepEqual(groups.flatMap((group) => group.labels), ["Proposal b", "Proposal d", "Proposal e"]);
  // The summary counts the writes and points at that list.
  assert.match(bulkDecisionSummary(report), /^Accepted 3 proposals\./);
  assert.match(bulkDecisionSummary(report), /3 proposals skipped — see the list below\./);
});

test("an all-ineligible selection still posts every id, and every row comes back named", async () => {
  const rows = selection([
    ["a", "ACCEPTED"],
    ["b", "REJECTED"],
    ["c", "WITHDRAWN"],
  ]);
  const { body, report } = await runSelection("MAYBE", rows);

  // Nothing to write is not nothing to send: an empty body would be refused by
  // the schema's own `.min(1)` and the operator would get an error where they
  // should get three named reasons.
  assert.deepEqual(body.abstractIds, ["a", "b", "c"]);
  assert.equal(body.decision, "MAYBE");
  assert.equal(report.decided, 0);
  assert.equal(report.skipped, 3);

  const groups = bulkDecisionSkipGroups(report, new Map(rows.map((r) => [r.id, r.title])));
  assert.deepEqual(groups.flatMap((group) => group.ids).sort(), ["a", "b", "c"]);
  for (const group of groups) {
    assert.equal(group.reason, BULK_DECISION_SKIP_REASONS[group.reasonCode]);
    assert.notEqual(group.reason, "");
  }
  assert.deepEqual(
    groups.map((group) => group.reasonCode),
    ["ABSTRACT_ALREADY_DECIDED", "ABSTRACT_WITHDRAWN"],
  );
  // And the receipt must not read as success on a batch that wrote nothing.
  const summary = bulkDecisionSummary(report);
  assert.match(summary, /^Nothing was changed\. 3 proposals skipped/);
  assert.ok(summary.includes(BULK_DECISION_NO_EMAIL_SENTENCE_PAST));
});

test("a same-reason group larger than five still names every proposal in it", async () => {
  // The receipt used to list titles only for groups of five or fewer. A count
  // without names answers "how many?" and withholds "which ones do I open?" —
  // the same silence as a filtered request, one screen later, and it appeared
  // exactly when the batch was big enough for the operator to need the list.
  const rows = selection(
    Array.from({ length: 8 }, (_, index) => [`old-${index}`, "ACCEPTED"] as [string, AbstractStatus]),
  );
  const { body, report } = await runSelection("REJECTED", rows);
  assert.equal(body.abstractIds.length, 8);
  assert.equal(report.skipped, 8);

  const groups = bulkDecisionSkipGroups(report, new Map(rows.map((r) => [r.id, r.title])));
  assert.equal(groups.length, 1);
  const [group] = groups;
  assert.equal(group.reasonCode, "ABSTRACT_ALREADY_DECIDED");
  // All eight, not the first five: one label per id, in report order.
  assert.equal(group.ids.length, 8);
  assert.deepEqual(group.labels, rows.map((row) => row.title));
  assert.equal(group.labels.length, group.ids.length);
  assert.equal(new Set(group.labels).size, 8);

  // And at the batch cap, which is the largest group the server can report.
  const many = selection(
    Array.from(
      { length: BULK_ABSTRACT_DECISION_LIMIT },
      (_, index) => [`w-${index}`, "WITHDRAWN"] as [string, AbstractStatus],
    ),
  );
  const capped = await runSelection("ACCEPTED", many);
  const [cappedGroup] = bulkDecisionSkipGroups(capped.report, new Map(many.map((r) => [r.id, r.title])));
  assert.equal(cappedGroup.labels.length, BULK_ABSTRACT_DECISION_LIMIT);
  assert.equal(cappedGroup.labels.at(-1), `Proposal w-${BULK_ABSTRACT_DECISION_LIMIT - 1}`);
});

test("a skipped row the selection has no title for is still named by its id", () => {
  // `labels` is never short and never blank: the ids come back from the server
  // and the map is the client's, so a stale or missing title degrades to the id
  // rather than to an empty line.
  const groups = bulkDecisionSkipGroups(
    report({
      results: [
        { abstractId: "a", outcome: "SKIPPED", reasonCode: "ABSTRACT_NOT_FOUND", reason: BULK_DECISION_SKIP_REASONS.ABSTRACT_NOT_FOUND },
        { abstractId: "b", outcome: "SKIPPED", reasonCode: "ABSTRACT_NOT_FOUND", reason: BULK_DECISION_SKIP_REASONS.ABSTRACT_NOT_FOUND },
      ],
      decided: 0,
      skipped: 2,
    }),
    new Map([["b", "Known title"]]),
  );
  assert.deepEqual(groups[0].labels, ["a", "Known title"]);
});

test("the dead-button notice names the selection and the real gate", () => {
  // It must not read as "nothing selected" — the rows are ticked and visible
  // right beside it.
  const many = bulkDecisionNothingEligibleNotice(6);
  assert.match(many, /^None of the 6 proposals selected is awaiting a decision/);
  assert.match(many, /nothing to apply/);
  assert.match(many, /Open a proposal to change its decision\.$/);
  assert.equal(bulkDecisionNothingEligibleNotice(1),
    "The selected proposal is not awaiting a decision, so there is nothing to apply. Open it to change its decision.");

  // And it must not claim a decision that was never made: a selection of drafts
  // or withdrawn rows is ineligible too, and "already has a decision" would send
  // an organizer looking for one nobody wrote.
  for (const count of [1, 2, 40]) {
    assert.equal(/already ha[sv]e? a decision/.test(bulkDecisionNothingEligibleNotice(count)), false, `${count}`);
    assert.equal(/already decided/.test(bulkDecisionNothingEligibleNotice(count)), false, `${count}`);
  }
  assert.equal(bulkDecisionNothingEligibleNotice(-2).startsWith("None of the 0 proposals"), true);
});

test("the request body is the selection verbatim, whatever the client thinks of it", () => {
  // Order preserved (the report is returned in request order), duplicates left
  // for the schema's own `uniqueIds` to collapse server-side, and no status
  // anywhere in the shape: this function cannot filter what it never reads.
  const rows = selection([["z", "WITHDRAWN"], ["y", "SUBMITTED"], ["x", "MAYBE"]]);
  assert.deepEqual(bulkDecisionRequestBody("REJECTED", rows), {
    abstractIds: ["z", "y", "x"],
    decision: "REJECTED",
  });
  assert.deepEqual(bulkDecisionRequestBody("ACCEPTED", []).abstractIds, []);
});

test("a full page of selected rows still fits one batch", () => {
  // The bar posts the whole selection, so the cap has to cover everything the
  // table can put on screen. If either constant moves without the other, an
  // operator's select-all starts 422-ing instead of reporting per-item.
  assert.ok(
    BULK_ABSTRACT_DECISION_LIMIT >= OPERATOR_QUERY_LIMITS.adminAbstracts,
    `bulk cap ${BULK_ABSTRACT_DECISION_LIMIT} < page size ${OPERATOR_QUERY_LIMITS.adminAbstracts}`,
  );
});

test("the skip list is empty when the server wrote everything", () => {
  assert.deepEqual(bulkDecisionSkipGroups(report({ results: [], skipped: 0 })), []);
  assert.deepEqual(
    bulkDecisionSkipGroups(
      report({
        results: [
          { abstractId: "a", outcome: "DECIDED", decision: "ACCEPTED", sessionCreated: true, tasksAssigned: 1 },
        ],
      }),
    ),
    [],
  );
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
