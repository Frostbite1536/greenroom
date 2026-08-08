import assert from "node:assert/strict";
import { test } from "node:test";
import { indexAssignmentProgress } from "./reads";

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
