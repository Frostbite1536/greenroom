import { speakerTaskCount } from "@/lib/decision-confirmation";
import type { AbstractDecision } from "@/lib/services/abstract-decision";
import type { BulkDecisionReport } from "@/lib/services/bulk-abstract-decision";

/**
 * What a bulk decision is about to do, and afterwards what it did.
 *
 * Two rules from batch 4 apply and pull in the same direction: confirm-or-
 * explain every judged-screen mutation, and name the consequence with the real
 * numbers once it has happened. A batch makes both sharper — a single decision
 * is one row an organizer is already looking at, but a selection is N rows they
 * ticked, and "Are you sure?" over a selection tells them nothing they did not
 * already know.
 *
 * So the prompt states the arithmetic before the click (how many proposals, how
 * many sessions that builds, that onboarding tasks follow) and the summary
 * states what the server actually reported after it (`decided`,
 * `sessionsCreated`, `tasksAssigned`, `skipped`) rather than repeating the
 * prompt's promise back.
 *
 * Both carry the email sentence, and it is the load-bearing one. "Preview-safe"
 * is the roadmap's own word for this feature: bulk deciding sends nothing, and
 * an operator who has just changed a hundred proposals is entitled to know that
 * before they go looking for what they might have mailed. Decision emails stay
 * in Operations, where each one is previewed and the send is bound to that
 * preview.
 *
 * Pure, so the copy is unit tested and cannot drift between the branches.
 */

/** The one sentence that must appear on every bulk-decision surface. */
export const BULK_DECISION_NO_EMAIL_SENTENCE =
  "No emails are sent; decision emails remain preview-gated in Operations.";

/** Its past tense, for the confirmation shown once the batch has run. */
export const BULK_DECISION_NO_EMAIL_SENTENCE_PAST =
  "No emails were sent; decision emails remain preview-gated in Operations.";

/** "1 proposal" / "12 proposals". */
export function proposalCount(count: number): string {
  const n = Math.max(0, Math.trunc(count));
  return `${n} proposal${n === 1 ? "" : "s"}`;
}

/** "1 confirmed session" / "12 confirmed sessions". */
export function confirmedSessionCount(count: number): string {
  const n = Math.max(0, Math.trunc(count));
  return `${n} confirmed session${n === 1 ? "" : "s"}`;
}

/** The button an operator pressed, in the vocabulary the drawer already uses. */
export function bulkDecisionActionLabel(decision: AbstractDecision): string {
  switch (decision) {
    case "ACCEPTED":
      return "Accept";
    case "MAYBE":
      return "Maybe";
    case "REJECTED":
      return "Decline";
  }
}

export type BulkDecisionPrompt = {
  decision: AbstractDecision;
  /** Selected rows still awaiting a decision — the ones the server will write. */
  eligible: number;
  /** Selected rows the server will skip, because they are already decided etc. */
  ineligible: number;
};

/** The dialog's own heading: the action and the size of the selection. */
export function bulkDecisionPromptTitle(prompt: BulkDecisionPrompt): string {
  return `${bulkDecisionActionLabel(prompt.decision)} ${proposalCount(prompt.eligible)}?`;
}

/**
 * The consequence, spelled out before the click.
 *
 * Only `ACCEPTED` builds anything, and it says exactly what and how much. The
 * other two say what they do NOT build, because the thing an organizer most
 * reasonably fears from a bulk button is a hundred talks or a hundred emails
 * appearing somewhere they did not look.
 */
export function bulkDecisionPromptBody(prompt: BulkDecisionPrompt): string {
  const n = Math.max(0, Math.trunc(prompt.eligible));
  switch (prompt.decision) {
    case "ACCEPTED":
      return `Accept ${proposalCount(n)} — this creates ${confirmedSessionCount(n)} and assigns onboarding tasks. ${BULK_DECISION_NO_EMAIL_SENTENCE}`;
    case "MAYBE":
      return `Mark ${proposalCount(n)} as maybe — no sessions are created and no speaker onboarding tasks are assigned. ${BULK_DECISION_NO_EMAIL_SENTENCE}`;
    case "REJECTED":
      return `Decline ${proposalCount(n)} — no sessions are created, and nothing is removed from the programme. ${BULK_DECISION_NO_EMAIL_SENTENCE}`;
  }
}

/**
 * The skip warning, or `null` when the whole selection is eligible.
 *
 * Shown before the click rather than only in the result: an operator who ticked
 * twenty rows and gets fifteen writes should have been told which fifteen were
 * live while they could still change the selection.
 */
export function bulkDecisionPromptSkipNotice(prompt: BulkDecisionPrompt): string | null {
  const n = Math.max(0, Math.trunc(prompt.ineligible));
  if (n === 0) return null;
  return `${proposalCount(n)} in this selection ${n === 1 ? "is" : "are"} skipped: bulk decisions only change proposals still awaiting a decision. Open a decided proposal to change it.`;
}

/** What the batch actually did, from the server's own per-item report. */
export function bulkDecisionSummary(report: BulkDecisionReport): string {
  const skipped = report.skipped > 0 ? ` ${proposalCount(report.skipped)} skipped — see the list below.` : "";

  if (report.decided === 0) {
    // Never claim an action over an empty write. This is the branch an
    // all-already-decided selection lands on, and it must not read as success.
    return `Nothing was changed.${skipped} ${BULK_DECISION_NO_EMAIL_SENTENCE_PAST}`;
  }

  const built =
    report.decision === "ACCEPTED"
      ? report.tasksAssigned > 0
        ? ` ${confirmedSessionCount(report.sessionsCreated)} and ${speakerTaskCount(report.tasksAssigned)} were created.`
        : ` ${confirmedSessionCount(report.sessionsCreated)} were created. No speaker onboarding tasks were added, because this event has no onboarding checklist yet.`
      : " No sessions and no speaker onboarding tasks were created.";

  const verb =
    report.decision === "ACCEPTED"
      ? "Accepted"
      : report.decision === "MAYBE"
        ? "Marked as maybe"
        : "Declined";

  return `${verb} ${proposalCount(report.decided)}.${built}${skipped} ${BULK_DECISION_NO_EMAIL_SENTENCE_PAST}`;
}
