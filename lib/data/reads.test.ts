import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ADMIN_ABSTRACT_SNAPSHOT_OPTIONS,
  indexAdminAnswers,
  indexAssignmentProgress,
  indexOrganizerReviewComments,
  planAdminAnswerRead,
  summarizeAdminAbstractMetrics,
} from "./reads";
import { ApiError } from "@/lib/api/http";

test("indexes review progress by abstract without dropping partial assignments", () => {
  const progress = indexAssignmentProgress([
    { abstractId: "abstract-a", status: "ASSIGNED", _count: { _all: 2 } },
    { abstractId: "abstract-a", status: "COMPLETED", _count: { _all: 1 } },
    { abstractId: "abstract-b", status: "COMPLETED", _count: { _all: 3 } },
  ]);

  assert.deepEqual(progress.get("abstract-a"), { reviewsTotal: 3, reviewsComplete: 1 });
  assert.deepEqual(progress.get("abstract-b"), { reviewsTotal: 3, reviewsComplete: 3 });
  assert.equal(progress.get("missing"), undefined);
});

test("admin answer allocation isolates one answer flood and retains later complete proposals", () => {
  const row = (abstractId: string, id: string) => ({
    abstractId,
    value: "saved",
    formField: { id, label: id, type: "SHORT_TEXT" as const, options: null },
  });

  const plan = planAdminAnswerRead(
    ["normal-first", "flooded", "normal-later"],
    [
      { abstractId: "normal-first", _count: { _all: 1 } },
      { abstractId: "flooded", _count: { _all: 5 } },
      { abstractId: "normal-later", _count: { _all: 1 } },
    ],
    3,
  );
  assert.deepEqual(plan.queryAbstractIds, ["normal-first", "normal-later"]);
  assert.deepEqual([...plan.unavailableAbstractIds], ["flooded"]);

  const indexed = indexAdminAnswers(
    [row("normal-first", "f1"), row("normal-later", "f2")],
    plan.expectedAnswerCounts,
    plan.unavailableAbstractIds,
  );
  assert.equal(indexed.byAbstract.get("normal-first")?.length, 1);
  assert.equal(indexed.byAbstract.get("normal-later")?.length, 1);
  assert.equal(indexed.byAbstract.has("flooded"), false);
  assert.equal(indexed.unavailableAbstractIds.has("flooded"), true);
});

test("a concurrent answer change withholds only that proposal, not its exact peers", () => {
  const row = (abstractId: string, id: string) => ({
    abstractId,
    value: "saved",
    formField: { id, label: id, type: "SHORT_TEXT" as const, options: null },
  });
  const plan = planAdminAnswerRead(
    ["changed", "stable"],
    [
      { abstractId: "changed", _count: { _all: 1 } },
      { abstractId: "stable", _count: { _all: 1 } },
    ],
    3,
  );
  const indexed = indexAdminAnswers(
    [row("changed", "first"), row("changed", "concurrent-extra"), row("stable", "only")],
    plan.expectedAnswerCounts,
  );

  assert.equal(indexed.unavailableAbstractIds.has("changed"), true);
  assert.equal(indexed.byAbstract.has("changed"), false);
  assert.equal(indexed.unavailableAbstractIds.has("stable"), false);
  assert.equal(indexed.byAbstract.get("stable")?.[0]?.fieldId, "only");
});

test("admin abstract metrics stay global rather than reflecting a bounded table page", () => {
  assert.deepEqual(
    summarizeAdminAbstractMetrics([
      { status: "DRAFT", _count: { _all: 80 } },
      { status: "SUBMITTED", _count: { _all: 12 } },
      { status: "UNDER_REVIEW", _count: { _all: 6 } },
      { status: "MAYBE", _count: { _all: 2 } },
      { status: "ACCEPTED", _count: { _all: 9 } },
    ]),
    { total: 109, pending: 20, accepted: 9 },
  );
});

test("admin abstract parent snapshot contract uses repeatable read isolation", () => {
  assert.deepEqual(ADMIN_ABSTRACT_SNAPSHOT_OPTIONS, { isolationLevel: "RepeatableRead" });
});

test("organizer review comments are one de-identified entry per review and admin-only", () => {
  const rows = [
    { abstractId: "abstract-a", evaluatorId: "evaluator-a", rubricKey: "clarity", comment: "Clear explanation" },
    { abstractId: "abstract-a", evaluatorId: "evaluator-a", rubricKey: "impact", comment: "Clear explanation" },
    { abstractId: "abstract-a", evaluatorId: "evaluator-b", rubricKey: "clarity", comment: "Useful for our audience" },
    { abstractId: "abstract-b", evaluatorId: "evaluator-c", rubricKey: "clarity", comment: "Needs examples" },
  ];

  assert.deepEqual(indexOrganizerReviewComments("ADMIN", rows)?.get("abstract-a"), [
    { comments: ["Clear explanation"] },
    { comments: ["Useful for our audience"] },
  ]);
  assert.equal(indexOrganizerReviewComments("EVALUATOR", rows), null);
});

test("divergent legacy review comments stay usable, grouped, and de-identified", () => {
  const comments = indexOrganizerReviewComments("ADMIN", [
    { abstractId: "abstract-a", evaluatorId: "evaluator-secret", rubricKey: "clarity", comment: "First legacy text" },
    { abstractId: "abstract-a", evaluatorId: "evaluator-secret", rubricKey: "impact", comment: "Second legacy text" },
  ]);
  assert.deepEqual(comments?.get("abstract-a"), [{ comments: ["First legacy text", "Second legacy text"] }]);
  assert.doesNotMatch(JSON.stringify(comments), /evaluator-secret/);
  assert.equal(indexOrganizerReviewComments("EVALUATOR", []), null);
});

test("organizer review comments fail closed at their bound", () => {
  const row = (comment: string) => ({
    abstractId: "abstract-a", evaluatorId: "evaluator-a", rubricKey: "clarity", comment,
  });
  assert.throws(
    () => indexOrganizerReviewComments("ADMIN", [row("one"), { ...row("one"), evaluatorId: "evaluator-b" }], 1),
    (error: unknown) =>
      error instanceof ApiError &&
      error.code === "EVENT_QUERY_LIMIT_EXCEEDED",
  );
});
