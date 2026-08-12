/**
 * Client-safe logic for the decision-note suggestion.
 *
 * Deliberately in `lib/` rather than `lib/assistant/`, beside the other pure UI
 * modules (`decision-confirmation.ts`, `abstract-decision-ui.ts`): everything
 * under `lib/assistant/` is server-only and reads the provider credential, and
 * `lib/assistant/client.test.ts` fails the build if a client component imports
 * from there. This module is the seam that keeps that rail true.
 *
 * The rule the whole feature turns on lives here: a generated suggestion is
 * never the organizer's text until they say so, and it never silently replaces
 * text they wrote. Applying is therefore two different operations depending on
 * whether the note is empty, and the difference is decided by a pure function
 * rather than by a component remembering to check.
 */

/**
 * The comment bounds the server applies, owned here because the disclosure
 * quotes them.
 *
 * Single-sourced deliberately: `lib/assistant/decision-note.ts` imports these
 * rather than declaring its own, so the numbers an organizer reads and the
 * numbers the projection enforces cannot drift apart. A pure, client-safe
 * module is the one place both a server module and a client component may read
 * from without breaking the server-only rail.
 */
export const DRAFT_COMMENT_LIMITS = {
  maxComments: 8,
  maxCommentChars: 600,
  maxTotalCommentChars: 3_000,
} as const;

/**
 * The disclosure sentence about comment text, built from the real bounds.
 *
 * The wording this replaces said comments are sent "word for word", which was
 * wrong in the opposite direction from the claim before it: the projection
 * flattens control characters and newlines, neutralizes delimiter runs, and
 * truncates both per comment and in total. "Never sent" understated what
 * leaves; "word for word" overstated it. This states the contract.
 */
export function describeCommentDisclosure(): string {
  return (
    "Reviewer comments are sent after safety normalization and length limits: line breaks and " +
    `control characters are flattened, and up to ${DRAFT_COMMENT_LIMITS.maxComments} comments are ` +
    `trimmed to ${DRAFT_COMMENT_LIMITS.maxCommentChars} characters each ` +
    `(${DRAFT_COMMENT_LIMITS.maxTotalCommentChars.toLocaleString("en-US")} in total). ` +
    "What is sent may still contain a name, an email address, or score-like wording a reviewer typed. " +
    "Uncheck the box above to send none of it."
  );
}

export type DraftSuggestion = {
  draft: string;
  commentsAvailable: number;
  commentIndexesUsed: number[];
};

/**
 * What a drafting request was asked for, captured at the moment it was fired.
 *
 * `seq` is a monotonic counter the panel bumps on every generation and on every
 * change that invalidates one. The selection fields ride alongside it rather
 * than instead of it: the counter alone would be sufficient, but a draft about
 * the wrong proposal is the one mistake here that can reach a speaker, and a
 * second independent reason to refuse it costs nothing.
 */
export type DraftRequestToken = {
  seq: number;
  abstractId: string;
  includeFeedback: boolean;
};

/**
 * Whether a response that has just arrived may still be shown.
 *
 * Without this, a slow request for proposal A resolves after the organizer has
 * moved to proposal B and installs A's draft under B's name — a suggestion
 * about the wrong talk, one click from a speaker's inbox. A superseded response
 * is dropped silently: the organizer abandoned that request by navigating away,
 * so an error about it would be noise about something they did not ask for and
 * cannot act on.
 */
export function isDraftResponseCurrent(request: DraftRequestToken, current: DraftRequestToken): boolean {
  return (
    request.seq === current.seq &&
    request.abstractId === current.abstractId &&
    request.includeFeedback === current.includeFeedback
  );
}

/**
 * What the suggestion was built from, shown beside it.
 *
 * Names the comments actually used, not the comments that existed, so an
 * organizer can tell a draft grounded in five comments from one grounded in
 * none — the CRM lesson about showing an insight's basis rather than implying
 * unexplained intelligence.
 */
export function describeDraftGrounding(suggestion: DraftSuggestion): string {
  const used = suggestion.commentIndexesUsed.length;
  if (used === 0) {
    return suggestion.commentsAvailable === 0
      ? "Written from the proposal title and your decision — this proposal has no reviewer comments."
      : "Written from the proposal title and your decision — no reviewer comments were included.";
  }
  const noun = `${used} reviewer comment${used === 1 ? "" : "s"}`;
  return used === suggestion.commentsAvailable
    ? `Based on ${noun}, plus the proposal title and your decision.`
    : `Based on ${noun} of ${suggestion.commentsAvailable}, plus the proposal title and your decision.`;
}

export type ApplyDraftOutcome =
  /** Written into the note. */
  | { status: "applied"; note: string }
  /** The note has organizer-authored text; nothing was changed. */
  | { status: "needs-confirmation" }
  /** Nothing to apply. */
  | { status: "empty" };

/**
 * Apply a suggestion to the personal note.
 *
 * A blank note takes the draft immediately — there is nothing to lose. A note
 * with anything in it is never overwritten without `confirmed`, which the panel
 * only sets from a second, explicit click. This is the assessment's one hard
 * UX requirement: generation must be suggestion-first, and no organizer should
 * lose a paragraph they wrote because a button did more than it said.
 */
export function applyDraftToNote(input: {
  note: string;
  draft: string;
  confirmed: boolean;
}): ApplyDraftOutcome {
  const draft = input.draft.trim();
  if (!draft) return { status: "empty" };
  if (input.note.trim() && !input.confirmed) return { status: "needs-confirmation" };
  return { status: "applied", note: draft };
}

/** Label for the apply control, so the button says what the click will do. */
export function describeApplyAction(note: string): string {
  return note.trim() ? "Replace my note" : "Use this note";
}

/**
 * Operator copy for a refusal from `POST /api/assistant/decision-note`.
 *
 * The server already sends a human message; this exists so the panel still says
 * something honest and actionable when it cannot reach the server at all, and
 * so "unavailable" never reads as "your note was lost".
 */
export function describeDraftFailure(message?: string | null): string {
  const trimmed = message?.trim();
  return trimmed && trimmed.length > 0
    ? trimmed
    : "We couldn't reach the drafting service. Your note is untouched — write it yourself, or try again.";
}
