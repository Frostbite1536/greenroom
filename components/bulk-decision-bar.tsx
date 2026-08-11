"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCheck, X } from "lucide-react";
import { apiPost } from "@/lib/api-client";
import {
  bulkDecisionActionLabel,
  bulkDecisionPromptBody,
  bulkDecisionPromptSkipNotice,
  bulkDecisionPromptTitle,
  bulkDecisionSummary,
  proposalCount,
} from "@/lib/bulk-decision-confirmation";
import { bulkDecisionEligibility } from "@/lib/services/abstract-decision";
import type { AbstractDecision } from "@/lib/services/abstract-decision";
import type { BulkDecisionReport } from "@/lib/services/bulk-abstract-decision";

/**
 * The bulk-decision toolbar and its confirmation, for `/admin/abstracts`.
 *
 * A separate component rather than more of `abstracts-table.tsx`, for two
 * reasons. The table owns exactly one `<dialog>` — the proposal drawer — and
 * that is a pinned contract (`modal-dialogs.source.test.ts`); a second dialog
 * literal in that file would be indistinguishable from the hand-rolled overlay
 * the drawer replaced. And this whole surface is additive: the table renders it
 * only when something is selected, so with JavaScript off it never mounts and
 * every server-rendered affordance beside it — the deep-linked drawer, the CSV
 * export anchor, the status links — behaves exactly as it did before.
 *
 * The confirmation follows the repo's own pattern rather than a `window.confirm`
 * like the single-row decline: a native `<dialog>` opened with `showModal()`,
 * named by its visible heading, and busy-gated on both dismissal routes while
 * the batch runs — the rule PR #89 established for the drawer and the agenda
 * dialogs already enforce. A batch is precisely the case where losing the
 * surface mid-write matters: the response is the only place the per-item
 * outcomes exist, and dismissing it would leave an operator who just changed
 * fifty proposals with no record of which fifty.
 *
 * The dialog does not close on success. It becomes the receipt — real numbers
 * from the server's own report, and every skipped proposal named with its
 * reason — and only "Done" clears the selection and dismisses it.
 */

export type BulkSelectableAbstract = {
  id: string;
  title: string;
  /** The stored `AbstractStatus`, widened exactly as the table widens it. */
  status: string;
};

const DECISIONS: { decision: AbstractDecision; label: string; className: string }[] = [
  { decision: "ACCEPTED", label: "Accept", className: "primary-button" },
  { decision: "MAYBE", label: "Maybe", className: "ghost-button" },
  { decision: "REJECTED", label: "Decline", className: "ghost-button danger-button" },
];

/**
 * Which of the selection the server will actually write.
 *
 * The same predicate the route runs, so the prompt's arithmetic matches the
 * result's. It is a preview, never an authorization: the server re-reads every
 * status under that abstract's own lock and is free to skip more than this
 * counted — which is exactly what the per-item report is for.
 */
function splitSelection(selected: readonly BulkSelectableAbstract[]) {
  const eligible: BulkSelectableAbstract[] = [];
  const ineligible: BulkSelectableAbstract[] = [];
  for (const row of selected) {
    const verdict = bulkDecisionEligibility(row.status as Parameters<typeof bulkDecisionEligibility>[0]);
    (verdict === "ELIGIBLE" ? eligible : ineligible).push(row);
  }
  return { eligible, ineligible };
}

export function BulkDecisionBar({
  selected,
  onClearSelection,
}: {
  selected: BulkSelectableAbstract[];
  onClearSelection: () => void;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const ids = useId();
  const [pending, startTransition] = useTransition();
  const [decision, setDecision] = useState<AbstractDecision | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<BulkDecisionReport | null>(null);

  const open = decision !== null;
  const { eligible, ineligible } = splitSelection(selected);
  const titles = new Map(selected.map((row) => [row.id, row.title]));
  // One prompt shape for the heading, the body and the skip notice, so the
  // three cannot disagree about how many proposals this is about.
  const prompt = decision
    ? { decision, eligible: eligible.length, ineligible: ineligible.length }
    : null;
  const skipNotice = prompt ? bulkDecisionPromptSkipNotice(prompt) : null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // showModal() gives the focus trap, Escape handling and inert background
    // for free — the same guarded open every other dialog in this repo uses.
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  function dismiss() {
    // Never while a batch is in flight: the response carries the only copy of
    // the per-item outcomes, and the write would continue with nothing to
    // report to. Both dismissal routes and every button consult this.
    if (busy) return;
    setDecision(null);
    setError(null);
    // A finished batch clears the selection on the way out: those rows have
    // been decided, and leaving them ticked invites a second identical batch.
    if (report) {
      setReport(null);
      onClearSelection();
    }
  }

  async function run(target: AbstractDecision) {
    setBusy(true);
    setError(null);
    const res = await apiPost<BulkDecisionReport>("/api/evaluations/decisions/bulk", {
      abstractIds: eligible.map((row) => row.id),
      decision: target,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setReport(res.data);
    startTransition(() => router.refresh());
  }

  if (selected.length === 0) return null;

  return (
    <div className="bulk-decision-bar" role="group" aria-label="Bulk decisions">
      <span className="bulk-decision-count" role="status">
        <CheckCheck size={15} aria-hidden="true" /> {proposalCount(selected.length)} selected
      </span>
      {ineligible.length > 0 ? (
        <span className="hint">{proposalCount(eligible.length)} still awaiting a decision</span>
      ) : null}
      {DECISIONS.map((option) => (
        <button
          key={option.decision}
          type="button"
          className={option.className}
          disabled={eligible.length === 0}
          onClick={() => setDecision(option.decision)}
        >
          {option.label}
        </button>
      ))}
      <button type="button" className="link-button" onClick={onClearSelection}>
        Clear selection
      </button>
      {eligible.length === 0 ? (
        <span className="hint">
          Every selected proposal already has a decision. Open one to change it.
        </span>
      ) : null}

      <dialog
        ref={dialogRef}
        className="app-dialog bulk-decision-dialog"
        aria-labelledby={`${ids}-title`}
        onClose={dismiss}
        // Escape must not discard the batch while it runs, and must not discard
        // the receipt before it has been read.
        onCancel={(event) => {
          if (busy) event.preventDefault();
          else dismiss();
        }}
        // Padding sits on the body, so a mousedown landing on the dialog itself
        // is a backdrop click. Gated on the same `busy` the buttons disable on.
        onMouseDown={(event) => {
          if (event.target === dialogRef.current && !busy) dismiss();
        }}
      >
        <div className="bulk-decision-dialog-body">
          {report ? (
            <>
              <h2 id={`${ids}-title`}>Bulk decision applied</h2>
              <p role="status">{bulkDecisionSummary(report)}</p>
              <BulkDecisionSkips report={report} titles={titles} />
              <div className="bulk-decision-actions">
                <button type="button" className="primary-button" onClick={dismiss}>
                  Done
                </button>
              </div>
            </>
          ) : prompt ? (
            <>
              <h2 id={`${ids}-title`}>{bulkDecisionPromptTitle(prompt)}</h2>
              <p>{bulkDecisionPromptBody(prompt)}</p>
              {skipNotice ? (
                <p className="conflict-banner" role="alert">
                  <AlertTriangle size={16} aria-hidden="true" />
                  <span>{skipNotice}</span>
                </p>
              ) : null}
              {error ? (
                <p className="field-error" role="alert">
                  {error}
                </p>
              ) : null}
              <div className="bulk-decision-actions">
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy || pending}
                  onClick={() => run(prompt.decision)}
                >
                  {busy ? "Applying…" : bulkDecisionActionLabel(prompt.decision)}
                </button>
                <button type="button" className="ghost-button" disabled={busy} onClick={dismiss}>
                  <X size={15} aria-hidden="true" /> Cancel
                </button>
              </div>
            </>
          ) : null}
        </div>
      </dialog>
    </div>
  );
}

/**
 * Every skipped proposal, grouped by the server's own reason.
 *
 * Grouped rather than listed one per row because a hundred-item batch would
 * otherwise print a hundred lines, and because the reason is the actionable
 * part: "already decided" tells an operator to open those proposals, "not found
 * in this event" tells them their selection was stale. Titles are named up to a
 * readable number so a small skip is still specific.
 */
function BulkDecisionSkips({
  report,
  titles,
}: {
  report: BulkDecisionReport;
  titles: Map<string, string>;
}) {
  const skipped = report.results.filter((item) => item.outcome === "SKIPPED");
  if (skipped.length === 0) return null;

  const groups = new Map<string, { reason: string; ids: string[] }>();
  for (const item of skipped) {
    if (item.outcome !== "SKIPPED") continue;
    const group = groups.get(item.reasonCode) ?? { reason: item.reason, ids: [] };
    group.ids.push(item.abstractId);
    groups.set(item.reasonCode, group);
  }

  return (
    <section aria-label="Skipped proposals" className="bulk-decision-skips">
      <ul>
        {[...groups.entries()].map(([code, group]) => (
          <li key={code}>
            <strong>{proposalCount(group.ids.length)}</strong> — {group.reason}
            {group.ids.length <= 5 ? (
              <div className="cell-sub">
                {group.ids.map((id) => titles.get(id) ?? id).join(", ")}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
