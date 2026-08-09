import assert from "node:assert/strict";
import { test } from "node:test";
import { indexAdminAnswers, indexAssignmentProgress } from "./reads";

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
