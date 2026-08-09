import assert from "node:assert/strict";
import { test } from "node:test";
import { indexAdminAnswers, indexAssignmentProgress, indexOrganizerReviewComments } from "./reads";
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

test("admin answer indexing is all-or-nothing at the event bound", () => {
  const row = (abstractId: string, id: string) => ({
    abstractId,
    value: "saved",
    formField: { id, label: id, type: "SHORT_TEXT" as const, options: null },
  });

  const complete = indexAdminAnswers([row("a", "f1"), row("b", "f2")], 2);
  assert.equal(complete.unavailable, false);
  assert.equal(complete.byAbstract.get("a")?.length, 1);

  const overBound = indexAdminAnswers([row("a", "f1"), row("a", "f2"), row("b", "f3")], 2);
  assert.equal(overBound.unavailable, true);
  assert.equal(overBound.byAbstract.size, 0, "must not expose a partial proposal at the cutoff");
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
