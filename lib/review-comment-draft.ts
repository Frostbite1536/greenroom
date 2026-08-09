export type ReviewCommentDraft = {
  /** Latest authoritative comment for this evaluator and abstract. */
  baseline: string | null;
  /** Text currently visible in the evaluator's textarea. */
  draft: string;
};

export type ReviewCommentUpdate = string | null | undefined;

type RubricKey = { key: string };
type ReviewScoreEntry = { rubricKey: string; score: number; comment?: string | null };

/** Start a per-abstract draft from the caller-scoped server projection. */
export function createReviewCommentDraft(baseline: string | null): ReviewCommentDraft {
  return { baseline, draft: baseline ?? "" };
}

/** Keep a separate draft for each queue row so moving between proposals loses no text. */
export function reviewCommentDraftForRow(
  drafts: Readonly<Record<string, ReviewCommentDraft>>,
  abstractId: string,
  baseline: string | null,
): ReviewCommentDraft {
  return drafts[abstractId] ?? createReviewCommentDraft(baseline);
}

/**
 * Omit an untouched (or restored) note so numeric-only updates preserve it.
 * A nonblank edit is trimmed for the server; clearing a stored note is the one
 * deliberate null case. Blank text is never sent as an ambiguous string.
 */
export function planReviewCommentUpdate(draft: ReviewCommentDraft): ReviewCommentUpdate {
  const baselineText = draft.baseline ?? "";
  if (draft.draft === baselineText) return undefined;

  const trimmed = draft.draft.trim();
  if (trimmed === "") return draft.baseline === null ? undefined : null;
  return trimmed === baselineText ? undefined : trimmed;
}

/**
 * An RSC refresh adopts server truth only when there is no newer local edit.
 * Otherwise it advances the baseline while keeping the visible draft intact.
 */
export function reconcileReviewCommentDraft(
  draft: ReviewCommentDraft,
  serverComment: string | null,
): ReviewCommentDraft {
  return planReviewCommentUpdate(draft) === undefined
    ? createReviewCommentDraft(serverComment)
    : { baseline: serverComment, draft: draft.draft };
}

/**
 * The successful score response has no comment payload. Reconcile the submitted
 * snapshot first, so a text change made during that request stays dirty until
 * the following server refresh can confirm the latest truth.
 */
export function reconcileSubmittedReviewCommentDraft(
  current: ReviewCommentDraft,
  submitted: ReviewCommentDraft,
): ReviewCommentDraft {
  const submittedUpdate = planReviewCommentUpdate(submitted);
  const expectedBaseline = submittedUpdate === undefined ? submitted.baseline : submittedUpdate;
  return {
    baseline: expectedBaseline,
    draft: current.draft === submitted.draft ? expectedBaseline ?? "" : current.draft,
  };
}

/** Attach at most one overall note to the first rubric entry, as the API requires. */
export function planReviewScoreEntries(
  rubric: readonly RubricKey[],
  scores: Readonly<Record<string, number>>,
  commentUpdate: ReviewCommentUpdate,
): ReviewScoreEntry[] {
  return rubric.map((criterion, index) => ({
    rubricKey: criterion.key,
    score: scores[criterion.key]!,
    ...(index === 0 && commentUpdate !== undefined ? { comment: commentUpdate } : {}),
  }));
}
