import assert from "node:assert/strict";
import test from "node:test";
import { reviewScoreInputSchema } from "@/types/api";
import {
  overallReviewCommentKeyChanged,
  resolveOverallReviewComment,
  reviewScoreCreateData,
  reviewScoreUpdateData,
} from "@/lib/services/review-score-comment";
import { ApiError } from "@/lib/api/http";

test("score correction with an omitted comment preserves the stored comment", () => {
  assert.deepEqual(reviewScoreUpdateData({ score: 4 }), { score: 4 });
});

test("an explicit null score comment is the deliberate clear signal", () => {
  assert.deepEqual(reviewScoreUpdateData({ score: 4, comment: null }), { score: 4, comment: null });
  assert.deepEqual(reviewScoreCreateData({ score: 4 }), { score: 4, comment: null });
});

test("new score writes allow one overall comment only on the first rubric key", () => {
  const entries = [
    { rubricKey: "clarity", comment: "A single review note" },
    { rubricKey: "impact" },
  ];
  assert.deepEqual(resolveOverallReviewComment(entries, ["clarity", "impact"]), {
    rubricKey: "clarity",
    comment: "A single review note",
  });
  assert.equal(resolveOverallReviewComment([{ rubricKey: "clarity" }], ["clarity"]), null);

  for (const invalid of [
    [{ rubricKey: "impact", comment: "Wrong criterion" }],
    [{ rubricKey: "clarity", comment: "First" }, { rubricKey: "impact", comment: "Second" }],
  ]) {
    assert.throws(
      () => resolveOverallReviewComment(invalid, ["clarity", "impact"]),
      (error: unknown) => error instanceof ApiError && error.status === 422 && error.code === "INVALID_REVIEW_COMMENT",
    );
  }
});

test("a rubric reorder is detectable only when it moves the overall comment key", () => {
  const current = [
    { key: "clarity", label: "Clarity", min: 1, max: 5, weight: 1 },
    { key: "impact", label: "Impact", min: 1, max: 5, weight: 1 },
  ];

  assert.equal(overallReviewCommentKeyChanged(current, current), false);
  assert.equal(overallReviewCommentKeyChanged(current, [current[1], current[0]]), true);
  assert.equal(overallReviewCommentKeyChanged([], current), true);
});

test("review score comments accept nonblank text or null, never an ambiguous blank", () => {
  const base = { planId: "plan-1", abstractId: "abstract-1", complete: false, scores: [{ rubricKey: "quality", score: 4 }] };
  assert.equal(reviewScoreInputSchema.safeParse(base).success, true);
  assert.equal(reviewScoreInputSchema.safeParse({ ...base, scores: [{ ...base.scores[0], comment: null }] }).success, true);
  assert.equal(reviewScoreInputSchema.safeParse({ ...base, scores: [{ ...base.scores[0], comment: "Useful detail" }] }).success, true);
  assert.equal(reviewScoreInputSchema.safeParse({ ...base, scores: [{ ...base.scores[0], comment: "   " }] }).success, false);
});
