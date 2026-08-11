import assert from "node:assert/strict";
import test from "node:test";
import {
  BULK_DECISION_SKIP_REASONS,
  runBulkAbstractDecision,
  type BulkDecisionItem,
  type DecideOneAbstract,
} from "@/lib/services/bulk-abstract-decision";
import type { AbstractDecisionWriteResult } from "@/lib/services/abstract-decision-write";

/**
 * The property a bulk decision lives or dies on: one item's failure is one
 * item's failure.
 *
 * The writer is injected, so this is proved without a database — which is the
 * only way to prove it at all, because the interesting case is a transaction
 * that rolls back mid-batch and the whole claim is about what happens to the
 * OTHER transactions. A fake that throws on item 2 of 3 answers that directly;
 * a fixture-driven integration test would prove it for one shape of failure and
 * leave the rest to hope.
 */

const written = (over: Partial<Extract<AbstractDecisionWriteResult, { decided: true }>> = {}) =>
  ({
    decided: true,
    decision: "ACCEPTED",
    sessionId: "session-1",
    sessionCreated: true,
    tasksAssigned: 3,
    topicReconciled: false,
    summaryReconciled: false,
    ...over,
  }) satisfies AbstractDecisionWriteResult;

/** Records the order it was called in, so "kept going" is observable. */
function recordingWriter(
  outcomes: Record<string, AbstractDecisionWriteResult | Error>,
): { decideOne: DecideOneAbstract; calls: string[] } {
  const calls: string[] = [];
  const decideOne: DecideOneAbstract = async (abstractId) => {
    calls.push(abstractId);
    const outcome = outcomes[abstractId];
    if (outcome instanceof Error) throw outcome;
    return outcome ?? { decided: false, refusal: "ABSTRACT_NOT_FOUND" };
  };
  return { decideOne, calls };
}

test("a failing item does not roll back, cancel, or hide the items around it", async (t) => {
  // The middle abstract's own transaction throws. Its neighbours have already
  // committed (a) and must still be attempted (c) — that is the entire reason
  // the route runs one transaction per abstract rather than one per batch.
  t.mock.method(console, "error", () => {});
  const { decideOne, calls } = recordingWriter({
    a: written({ sessionCreated: true, tasksAssigned: 2 }),
    b: new Error("deadlock detected"),
    c: written({ sessionCreated: true, tasksAssigned: 4 }),
  });

  const report = await runBulkAbstractDecision("ACCEPTED", ["a", "b", "c"], decideOne);

  // It kept going: the third item was attempted after the second threw.
  assert.deepEqual(calls, ["a", "b", "c"]);
  assert.equal(report.requested, 3);
  assert.equal(report.decided, 2);
  assert.equal(report.skipped, 1);
  // And the successful items' consequences survive intact — a batch that
  // discarded these to report the failure would be the bug this prevents.
  assert.equal(report.sessionsCreated, 2);
  assert.equal(report.tasksAssigned, 6);

  const failed = report.results[1];
  assert.equal(failed.outcome, "SKIPPED");
  assert.equal(failed.outcome === "SKIPPED" && failed.reasonCode, "DECISION_FAILED");
  assert.match(
    failed.outcome === "SKIPPED" ? failed.reason : "",
    /the others in this batch were unaffected/,
  );
  // The thrown error is logged, never returned: a database message is not
  // operator copy and must not reach a browser.
  assert.equal(/deadlock/.test(JSON.stringify(report)), false);
});

test("every requested id appears in the report exactly once, in request order", async () => {
  const { decideOne } = recordingWriter({
    first: written(),
    second: { decided: false, refusal: "ABSTRACT_ALREADY_DECIDED" },
    third: written({ sessionCreated: false, tasksAssigned: 0 }),
  });

  const report = await runBulkAbstractDecision("ACCEPTED", ["first", "second", "third"], decideOne);

  assert.deepEqual(
    report.results.map((item) => item.abstractId),
    ["first", "second", "third"],
    "an operator who selected three rows must get three answers, in the order they sent them",
  );
  assert.equal(report.results.length, report.requested);
  assert.equal(report.decided + report.skipped, report.requested);
});

test("each refusal the writer can return becomes a named skip, never a silent drop", async () => {
  // Every code in the table is reachable, and every one carries a sentence. An
  // unnamed skip is indistinguishable from a lost write.
  const codes = Object.keys(BULK_DECISION_SKIP_REASONS).filter((code) => code !== "DECISION_FAILED");
  assert.ok(codes.length >= 5, `expected the writer's whole refusal vocabulary, got ${codes.length}`);

  for (const code of codes) {
    const { decideOne } = recordingWriter({
      only: { decided: false, refusal: code as "ABSTRACT_NOT_FOUND" },
    });
    const report = await runBulkAbstractDecision("MAYBE", ["only"], decideOne);
    assert.equal(report.decided, 0);
    assert.equal(report.skipped, 1);
    const item = report.results[0] as Extract<BulkDecisionItem, { outcome: "SKIPPED" }>;
    assert.equal(item.reasonCode, code);
    assert.equal(item.reason, BULK_DECISION_SKIP_REASONS[item.reasonCode]);
    assert.ok(item.reason.trim().length > 0, `${code} has no operator-facing reason`);
  }
});

test("the two skips an organizer will actually hit read as instructions", async () => {
  const { decideOne } = recordingWriter({
    decided: { decided: false, refusal: "ABSTRACT_ALREADY_DECIDED" },
    "other-event": { decided: false, refusal: "ABSTRACT_NOT_FOUND" },
  });
  const report = await runBulkAbstractDecision("ACCEPTED", ["decided", "other-event"], decideOne);

  const reasons = report.results.map((item) => (item.outcome === "SKIPPED" ? item.reason : ""));
  // Already decided: bulk will not reverse an outcome, and says where to.
  assert.match(reasons[0], /Already decided/);
  assert.match(reasons[0], /Change decision/);
  // A cross-event id is reported exactly as a missing one — the route is not an
  // existence oracle for another event's proposals.
  assert.equal(reasons[1], "Not found in this event.");
});

test("counts report what was built, never what already existed", async () => {
  // Re-accepting tops up rather than creating, so a decided item with
  // `sessionCreated: false` must not inflate `sessionsCreated`.
  const { decideOne } = recordingWriter({
    fresh: written({ sessionCreated: true, tasksAssigned: 2 }),
    existing: written({ sessionCreated: false, tasksAssigned: 0 }),
    "topped-up": written({ sessionCreated: false, tasksAssigned: 1 }),
  });

  const report = await runBulkAbstractDecision("ACCEPTED", ["fresh", "existing", "topped-up"], decideOne);

  assert.equal(report.decided, 3);
  assert.equal(report.sessionsCreated, 1);
  assert.equal(report.tasksAssigned, 3);
});

test("a selection the server writes nothing from is reported as such, not as success", async () => {
  const { decideOne } = recordingWriter({
    a: { decided: false, refusal: "ABSTRACT_WITHDRAWN" },
    b: { decided: false, refusal: "ABSTRACT_NOT_SUBMITTED" },
  });
  const report = await runBulkAbstractDecision("REJECTED", ["a", "b"], decideOne);

  assert.equal(report.decision, "REJECTED");
  assert.equal(report.decided, 0);
  assert.equal(report.skipped, 2);
  assert.equal(report.sessionsCreated, 0);
  assert.equal(report.tasksAssigned, 0);
});

test("the batch is sequential, so two items never race for the same lock", async () => {
  // Overlapping calls would mean two of this batch's own transactions holding
  // advisory locks at once, which is how a batch deadlocks against a concurrent
  // speaker edit. Proved by observing that no second call starts before the
  // first resolves.
  let inFlight = 0;
  let maxInFlight = 0;
  const decideOne: DecideOneAbstract = async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    return written();
  };

  await runBulkAbstractDecision("ACCEPTED", ["a", "b", "c", "d"], decideOne);
  assert.equal(maxInFlight, 1);
});
