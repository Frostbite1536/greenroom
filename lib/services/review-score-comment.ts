import { ApiError } from "@/lib/api/http";
import { parseRubric } from "@/lib/services/rubric";

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

export type StoredReviewComment = {
  rubricKey: string;
  comment: string | null;
};

/**
 * Overall comments are persisted on the first rubric criterion. Moving that
 * key would make existing comments disappear from the evaluator projection,
 * so plan updates use this pure comparison before they write a new rubric.
 */
export function overallReviewCommentKeyChanged(
  currentRubric: unknown,
  nextRubric: readonly { key: string }[],
): boolean {
  return (parseRubric(currentRubric)[0]?.key ?? null) !== (nextRubric[0]?.key ?? null);
}

/**
 * Recover the one evaluator-visible overall comment from rows written before
 * comments were canonicalized onto the first rubric key. Prefer the current
 * plan order, then sort only truly orphaned former keys so this read remains
 * stable until an explicit write canonicalizes (or clears) the review again.
 */
export function selectEvaluatorReviewComment(
  rubricKeys: readonly string[],
  storedComments: readonly StoredReviewComment[],
): string | null {
  const commentByRubric = new Map<string, string>();
  for (const { rubricKey, comment } of storedComments) {
    if (comment !== null) commentByRubric.set(rubricKey, comment);
  }

  for (const rubricKey of rubricKeys) {
    const comment = commentByRubric.get(rubricKey);
    if (comment !== undefined) return comment;
  }

  const currentKeys = new Set(rubricKeys);
  const orphanedKeys = [...commentByRubric.keys()]
    .filter((rubricKey) => !currentKeys.has(rubricKey))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return orphanedKeys.length > 0 ? commentByRubric.get(orphanedKeys[0]) ?? null : null;
}

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
