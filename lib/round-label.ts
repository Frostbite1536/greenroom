/**
 * One label for a review round, with each part said exactly once.
 *
 * A round carries two independent facts: its `ordinal` (the round number, held
 * in `@@unique([eventId, ordinal])`) and its free-text `name`. Four surfaces
 * composed them as `Round ${ordinal} — ${name}` — but the round dialog's own
 * default name is `Round 1 — Program Committee`, and so is the seeded round's,
 * so every one of those surfaces printed
 * **"Round 1 — Round 1 — Program Committee"**.
 *
 * The fix is composition, not renaming: nothing here rewrites a stored name,
 * and the ordinal stays the authority for the number. The redundant prefix is
 * dropped from the *name* only when it agrees with the ordinal the caller
 * already prints.
 *
 * Deliberately NOT dropped when the numbers disagree. A round with ordinal 1
 * named "Round 2 — Rebuttals" is a mislabelled round, and hiding half of that
 * would turn a visible data problem into an invisible one. Both parts are shown
 * so the organizer can see the disagreement and fix the name.
 */

export type RoundLabelParts = {
  ordinal: number;
  name: string;
};

/**
 * `Round <n>` plus an optional separator, anchored at the start of a name.
 *
 * The separator set is the punctuation an author actually types between the
 * two parts (hyphen, en dash, em dash, colon, middot, pipe); plain whitespace
 * counts too, so `"Round 1 Program Committee"` collapses as well.
 */
const ROUND_NAME_PREFIX = /^round\s*(\d+)\s*(?:[-–—:·|]\s*)?/i;

/**
 * The part of the name that is not already carried by the round number, or
 * `null` when the name says nothing the ordinal does not.
 *
 * Used directly by surfaces that render the number and the name as two separate
 * elements (the round card's heading and its sub-line), where joining them into
 * one string would be wrong.
 */
export function roundNameSuffix(round: RoundLabelParts): string | null {
  const name = round.name.trim();
  if (name === "") return null;

  const match = ROUND_NAME_PREFIX.exec(name);
  // No prefix at all, or a prefix naming a different round: the whole stored
  // name is meaningful and is returned untouched.
  if (!match || Number(match[1]) !== round.ordinal) return name;

  const rest = name.slice(match[0].length).trim();
  return rest === "" ? null : rest;
}

/**
 * The single-string form: `Round 1 — Program Committee`, or plain `Round 1`
 * when the name adds nothing. Used by the round selectors, the drawer's
 * decision-round row, and the CSV export header.
 */
export function roundLabel(round: RoundLabelParts): string {
  const suffix = roundNameSuffix(round);
  return suffix === null ? `Round ${round.ordinal}` : `Round ${round.ordinal} — ${suffix}`;
}
