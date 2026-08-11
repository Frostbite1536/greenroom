import { speakerTaskCount } from "@/lib/decision-confirmation";
import type { AbstractDecision } from "@/lib/services/abstract-decision";
import type {
  BulkDecisionReport,
  BulkDecisionSkipReason,
} from "@/lib/services/bulk-abstract-decision";

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
      return `Decline ${proposalCount(n)} — no sessions are created, and nothing is removed from the program. ${BULK_DECISION_NO_EMAIL_SENTENCE}`;
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

/**
 * Why the buttons are dead while rows are still ticked.
 *
 * Two things this must not say. It must not read as "nothing is selected" — the
 * selection is right there beside it and the operator built it deliberately. And
 * it must not claim every selected proposal is already decided: withdrawn rows
 * and drafts are ineligible too, and telling an organizer their drafts "already
 * have a decision" sends them looking for a decision nobody made.
 *
 * So it names the count they selected and the one property that actually gates
 * the batch — still awaiting a decision — and points at the single-proposal
 * route, which can do what bulk deliberately will not.
 */
export function bulkDecisionNothingEligibleNotice(selectedCount: number): string {
  const n = Math.max(0, Math.trunc(selectedCount));
  if (n === 1) {
    return "The selected proposal is not awaiting a decision, so there is nothing to apply. Open it to change its decision.";
  }
  return `None of the ${proposalCount(n)} selected is awaiting a decision, so there is nothing to apply. Open a proposal to change its decision.`;
}

/**
 * The request body for a batch: EVERY selected id, in selection order.
 *
 * The client's eligibility read is a preview and nothing more. It sizes the
 * prompt's arithmetic and warns about rows that look already-decided, but it
 * must never decide what the server is told about, for two reasons.
 *
 * It is not authoritative. The rows were rendered by an earlier response; a
 * proposal decided, withdrawn or submitted since then is a status this client
 * does not have. The server re-reads every status under that abstract's own
 * advisory lock, which is the only reading that can be acted on.
 *
 * And it would silently shrink the receipt. The report has one entry per
 * requested id, so an id withheld here is a row the operator ticked and gets no
 * answer about — indistinguishable, on the screen they are looking at, from a
 * row that was quietly decided. Sending the whole selection is what makes
 * "every selected proposal is either written or named with its reason" true.
 *
 * The selection cannot outgrow the batch cap: the table it is made in loads at
 * most `OPERATOR_QUERY_LIMITS.adminAbstracts` rows and
 * `BULK_ABSTRACT_DECISION_LIMIT` is the same number, so an unfiltered post of
 * everything on screen still fits. The unit tests pin those two together.
 */
export function bulkDecisionRequestBody(
  decision: AbstractDecision,
  selected: readonly { id: string }[],
): { abstractIds: string[]; decision: AbstractDecision } {
  return { abstractIds: selected.map((row) => row.id), decision };
}

/** One skip reason and the proposals the server reported under it. */
export type BulkDecisionSkipGroup = {
  reasonCode: BulkDecisionSkipReason;
  /** The server's own sentence for this reason, never re-worded here. */
  reason: string;
  ids: string[];
  /** Row titles where the selection knows them, else the id. */
  labels: string[];
};

/**
 * Every skipped proposal, grouped by the server's own reason code.
 *
 * Grouped rather than one line per row because a hundred-item batch would
 * otherwise print a hundred lines, and because the reason is the actionable
 * part: "already decided" tells an operator to open those proposals, "not found
 * in this event" tells them their selection was stale. Groups come back in the
 * order the reasons first appear in the report, so the list is stable.
 *
 * Pure, and separate from the component, so the promise that matters — no
 * skipped row goes unnamed — is unit tested rather than eyeballed.
 */
export function bulkDecisionSkipGroups(
  report: BulkDecisionReport,
  titles?: ReadonlyMap<string, string>,
): BulkDecisionSkipGroup[] {
  const groups = new Map<BulkDecisionSkipReason, BulkDecisionSkipGroup>();
  for (const item of report.results) {
    if (item.outcome !== "SKIPPED") continue;
    const group =
      groups.get(item.reasonCode) ??
      { reasonCode: item.reasonCode, reason: item.reason, ids: [], labels: [] };
    group.ids.push(item.abstractId);
    group.labels.push(titles?.get(item.abstractId) ?? item.abstractId);
    groups.set(item.reasonCode, group);
  }
  return [...groups.values()];
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
