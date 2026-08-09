import { ApiError } from "@/lib/api/http";

type ReviewScoreCommentInput = {
  score: number;
  comment?: string | null;
};

type ReviewScoreCommentEntry = Pick<ReviewScoreCommentInput, "comment"> & {
  rubricKey: string;
};

export type OverallReviewComment = {
  rubricKey: string;
  comment: string | null;
};

/**
 * A review has one overall comment, stored on the plan's first rubric key.
 * Requiring one authoritative entry keeps a direct client from creating
 * conflicting criterion-level comments that could later disrupt organizer UI.
 */
export function resolveOverallReviewComment(
  entries: readonly ReviewScoreCommentEntry[],
  rubricKeys: readonly string[],
): OverallReviewComment | null {
  const supplied = entries.filter(
    (entry): entry is ReviewScoreCommentEntry & { comment: string | null } => entry.comment !== undefined,
  );
  if (supplied.length === 0) return null;

  const authoritativeRubricKey = rubricKeys[0];
  if (supplied.length !== 1 || !authoritativeRubricKey || supplied[0].rubricKey !== authoritativeRubricKey) {
    throw new ApiError(
      422,
      "INVALID_REVIEW_COMMENT",
      "Send at most one overall review comment on the first rubric criterion.",
    );
  }
  return { rubricKey: authoritativeRubricKey, comment: supplied[0].comment };
}

/**
 * An omitted comment means the evaluator changed only the numeric score. A
 * deliberate `null` is the sole clearing signal; create still starts empty.
 */
export function reviewScoreUpdateData({ score, comment }: ReviewScoreCommentInput): {
  score: number;
  comment?: string | null;
} {
  return comment === undefined ? { score } : { score, comment };
}

export function reviewScoreCreateData({ score, comment }: ReviewScoreCommentInput): {
  score: number;
  comment: string | null;
} {
  return { score, comment: comment ?? null };
}
