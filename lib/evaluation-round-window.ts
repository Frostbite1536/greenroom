/**
 * The optional open/close window on a review round (ABS-01).
 *
 * `EvaluationPlan.startsAt` / `endsAt` and `evaluationPlanInputSchema` have
 * always accepted these instants — only the create dialog omitted the inputs,
 * so a round could never be given a schedule from the product. These helpers
 * are the whole contract: the dialog types event-local calendar dates, they
 * become the UTC instants the existing plans API already stores, and the round
 * list renders them back in the event's own timezone.
 *
 * Deliberately authoring + display only. Nothing here gates a score write; the
 * window records when a round is meant to run, and the round list says so.
 */

import { formatEventDateRange, zonedToUtcIso } from "./tz";

/** Event-local calendar dates exactly as a native `<input type="date">` holds them. */
export type RoundWindowDraft = {
  /** `YYYY-MM-DD`, or "" when the admin left the field blank. */
  opensOn: string;
  closesOn: string;
};

export const EMPTY_ROUND_WINDOW: RoundWindowDraft = { opensOn: "", closesOn: "" };

/**
 * Refusal text for a window that cannot exist, or null when it is usable.
 *
 * Both fields are optional, so a half-filled window is legitimate: an admin may
 * know the close date and not the open date. Only an inverted pair is refused.
 * ISO date keys are zero-padded, so a lexical compare is a calendar compare.
 */
export function roundWindowError(draft: RoundWindowDraft): string | null {
  const opensOn = draft.opensOn.trim();
  const closesOn = draft.closesOn.trim();
  if (!opensOn || !closesOn) return null;
  if (closesOn < opensOn) return "The close date must be on or after the open date.";
  return null;
}

/**
 * The `startsAt`/`endsAt` fragment to spread into the existing plans API body.
 *
 * A blank field is *omitted* rather than sent as null: `evaluationPlanInputSchema`
 * marks both optional and the route already maps an absent value to null, so an
 * unspecified date stays unspecified without widening the request contract.
 *
 * The close date takes the last minute of its event-local day — the same
 * open-at-midnight / close-at-end-of-day convention the CFP form builder uses
 * for its own date pair, so "closes on the 20th" includes the 20th.
 */
export function roundWindowInput(
  draft: RoundWindowDraft,
  timeZone: string,
): { startsAt?: string; endsAt?: string } {
  const opensOn = draft.opensOn.trim();
  const closesOn = draft.closesOn.trim();
  const input: { startsAt?: string; endsAt?: string } = {};
  if (opensOn) input.startsAt = zonedToUtcIso(opensOn, "00:00", timeZone);
  if (closesOn) input.endsAt = zonedToUtcIso(closesOn, "23:59", timeZone);
  return input;
}

/**
 * One honest line for the round list, or null when the round has no window.
 *
 * Each bound is formatted on its own rather than through a collapsing range:
 * `formatEventDateRange` prints only the start when the end precedes it, which
 * would silently hide an inverted window written by an older client or a direct
 * API call. Naming both bounds keeps stored data visible as it actually is.
 */
export function formatRoundWindow(
  startsAt: string | Date | null | undefined,
  endsAt: string | Date | null | undefined,
  timeZone: string,
): string | null {
  const opens = startsAt ? formatEventDateRange(startsAt, null, timeZone) : null;
  const closes = endsAt ? formatEventDateRange(endsAt, null, timeZone) : null;
  if (opens && closes) return `Opens ${opens} · Closes ${closes}`;
  if (opens) return `Opens ${opens}`;
  if (closes) return `Closes ${closes}`;
  return null;
}
