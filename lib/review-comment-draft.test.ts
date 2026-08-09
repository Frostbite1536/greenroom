import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createReviewCommentDraft,
  planReviewCommentUpdate,
  planReviewScoreEntries,
  reconcileReviewCommentDraft,
  reconcileSubmittedReviewCommentDraft,
  reviewCommentDraftForRow,
} from "./review-comment-draft";

test("untouched evaluator comment is omitted from a numeric review update", () => {
  const draft = createReviewCommentDraft("Saved note");
  assert.equal(planReviewCommentUpdate(draft), undefined);
  assert.deepEqual(
    planReviewScoreEntries(
      [{ key: "relevance" }, { key: "clarity" }],
      { relevance: 5, clarity: 4 },
      planReviewCommentUpdate(draft),
    ),
    [{ rubricKey: "relevance", score: 5 }, { rubricKey: "clarity", score: 4 }],
  );
});

test("a trimmed evaluator edit is sent only on the first rubric criterion", () => {
  const draft = { baseline: "Saved note", draft: "  Updated note  " };
  assert.equal(planReviewCommentUpdate(draft), "Updated note");
  assert.deepEqual(
    planReviewScoreEntries(
      [{ key: "relevance" }, { key: "clarity" }],
      { relevance: 5, clarity: 4 },
      planReviewCommentUpdate(draft),
    ),
    [
      { rubricKey: "relevance", score: 5, comment: "Updated note" },
      { rubricKey: "clarity", score: 4 },
    ],
  );
});

test("returning a review note to its baseline omits the comment", () => {
  assert.equal(planReviewCommentUpdate({ baseline: "Saved note", draft: "Saved note" }), undefined);
  assert.equal(planReviewCommentUpdate({ baseline: "Saved note", draft: " Saved note " }), undefined);
});

test("clearing an existing evaluator comment sends explicit null only", () => {
  const draft = { baseline: "Saved note", draft: "" };
  assert.equal(planReviewCommentUpdate(draft), null);
  assert.equal(planReviewCommentUpdate({ baseline: null, draft: "" }), undefined);
});

test("a newer keystroke survives the submitted snapshot and later server refresh", () => {
  const submitted = { baseline: "Saved note", draft: "Submitted note" };
  const afterSubmit = reconcileSubmittedReviewCommentDraft(
    { baseline: "Saved note", draft: "Newer note" },
    submitted,
  );
  assert.deepEqual(afterSubmit, { baseline: "Submitted note", draft: "Newer note" });
  assert.deepEqual(
    reconcileReviewCommentDraft(afterSubmit, "Submitted note"),
    { baseline: "Submitted note", draft: "Newer note" },
  );
  assert.deepEqual(
    reconcileReviewCommentDraft(createReviewCommentDraft("Saved note"), "Server correction"),
    createReviewCommentDraft("Server correction"),
  );
});

test("row switching retains each abstract's independent comment draft", () => {
  const drafts = {
    "abstract-a": { baseline: "Server A", draft: "Unsubmitted A" },
  };
  assert.deepEqual(reviewCommentDraftForRow(drafts, "abstract-a", "Server A"), drafts["abstract-a"]);
  assert.deepEqual(reviewCommentDraftForRow(drafts, "abstract-b", "Server B"), {
    baseline: "Server B", draft: "Server B",
  });
});
