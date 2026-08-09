"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ClipboardCheck,
  EyeOff,
  Plus,
  Trash2,
  UserPlus,
} from "lucide-react";
import type { EvaluationSetupView, SetupPlan } from "@/lib/data/reads";
import { apiPost, firstFieldErrors } from "@/lib/api-client";
import { EVALUATION_SETUP_STATUS_LABELS } from "@/lib/evaluation-setup-status";
import { uniqueRubricKeys } from "@/lib/rubric-key";
import { EmptyState, Pill, Switch } from "@/components/ui";

/** Sensible opening rubric so a brand-new event is one click, not a blank form. */
const STARTER_CRITERIA = [
  { label: "Relevance", description: "Fit for the audience and event theme.", min: 1, max: 5, weight: 1.5 },
  { label: "Originality", description: "Fresh perspective or novel material.", min: 1, max: 5, weight: 1 },
  { label: "Clarity", description: "Well-structured, understandable proposal.", min: 1, max: 5, weight: 1 },
  { label: "Speaker readiness", description: "Track record and delivery signals.", min: 1, max: 5, weight: 1 },
];

type DraftCriterion = { label: string; description: string; min: number; max: number; weight: number };

export function EvaluationSetup({ view }: { view: EvaluationSetupView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const latest = view.plans[view.plans.length - 1] ?? null;
  const [planId, setPlanId] = useState<string | null>(latest?.id ?? null);
  const plan = view.plans.find((p) => p.id === planId) ?? latest;

  const [creating, setCreating] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [reviewers, setReviewers] = useState<Set<string>>(new Set());
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [onlyUnassigned, setOnlyUnassigned] = useState(false);
  const [teamKey, setTeamKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const assignableAbstracts = useMemo(
    () => view.abstracts.filter((abstract) => abstract.assignable),
    [view.abstracts],
  );

  const visible = useMemo(() => {
    return assignableAbstracts.filter((a) => {
      if (categoryFilter !== "all" && a.categoryId !== categoryFilter) return false;
      if (onlyUnassigned && plan && (a.assignedByPlan[plan.id] ?? 0) > 0) return false;
      return true;
    });
  }, [assignableAbstracts, categoryFilter, onlyUnassigned, plan]);

  const unassignedCount = plan
    ? assignableAbstracts.filter((a) => (a.assignedByPlan[plan.id] ?? 0) === 0).length
    : assignableAbstracts.length;

  function selectPlan(nextPlanId: string) {
    setPlanId(nextPlanId);
    setPicked(new Set());
    setReviewers(new Set());
    setTeamKey("");
    setError(null);
    setNotice(null);
  }

  function toggle(set: Set<string>, id: string, apply: (s: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    apply(next);
  }

  async function assign() {
    if (!plan) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await apiPost<{ assignments: number }>("/api/evaluations/assignments", {
      planId: plan.id,
      abstractIds: [...picked],
      evaluatorIds: [...reviewers],
      ...(teamKey.trim() ? { teamKey: teamKey.trim() } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      const mapped = firstFieldErrors(res.error.fieldErrors);
      setError(Object.values(mapped)[0] ?? res.error.message);
      return;
    }
    setNotice(
      `Assigned ${picked.size} proposal${picked.size === 1 ? "" : "s"} to ${reviewers.size} reviewer${reviewers.size === 1 ? "" : "s"}. Any newly submitted proposal is now under review.`,
    );
    setPicked(new Set());
    startTransition(() => router.refresh());
  }

  // ---- Fresh event: nothing to set up yet --------------------------------
  if (view.plans.length === 0) {
    return (
      <>
        <div className="card">
          <EmptyState icon={<ClipboardCheck size={22} />} title="No review round yet">
            A review round holds your scoring rubric and decides who reviews what. Create one to
            start assigning proposals to your review team.
          </EmptyState>
          <div className="row" style={{ justifyContent: "center", paddingBottom: 24 }}>
            <button className="primary-button" type="button" onClick={() => setCreating(true)}>
              Create the first round
            </button>
          </div>
        </div>
        {creating ? (
          <RoundDialog
            eventId={view.eventId}
            nextOrdinal={1}
            onClose={() => setCreating(false)}
            onCreated={(id) => {
              setCreating(false);
              setPlanId(id);
              startTransition(() => router.refresh());
            }}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      {/* ---- Rounds ------------------------------------------------------ */}
      <div className="card setup-section">
        <div className="row wrap setup-head">
          <div>
            <h2>Review rounds</h2>
            <p className="hint">Each round has its own rubric and its own reviewer assignments.</p>
          </div>
          <span className="spacer" />
          <button className="ghost-button" type="button" onClick={() => setCreating(true)}>
            <Plus size={15} aria-hidden="true" /> New round
          </button>
        </div>

        <div className="round-list">
          {view.plans.map((p) => (
            <button
              type="button"
              key={p.id}
              className={`round-card ${p.id === plan?.id ? "active" : ""}`}
              aria-pressed={p.id === plan?.id}
              onClick={() => selectPlan(p.id)}
            >
              <div className="row wrap" style={{ gap: 8 }}>
                <strong>Round {p.ordinal}</strong>
                {p.isBlind ? (
                  <Pill tone="info"><EyeOff size={11} aria-hidden="true" /> Blind</Pill>
                ) : null}
              </div>
              <div className="cell-sub">{p.name}</div>
              <div className="cell-sub">
                {p.rubric.length} criteria · {p.assignmentCount === 0
                  ? "no active reviews"
                  : `${p.completedCount}/${p.assignmentCount} reviews done`}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ---- Assign ------------------------------------------------------ */}
      {plan ? (
        <div className="card setup-section">
          <div className="setup-head">
            <h2>Assign proposals to reviewers</h2>
            <p className="hint">
              Pick the proposals and the people who should review them, then assign. Anything
              still “Submitted” moves to “Under review”. Assigning twice is safe — it will not
              create duplicates.
            </p>
          </div>

          {view.evaluators.length === 0 ? (
            <EmptyState icon={<UserPlus size={22} />} title="Nobody can review yet">
              Add people to this event as evaluators, then come back to assign proposals. Reviewers
              sign in with the Evaluator persona from the login screen.
            </EmptyState>
          ) : view.abstracts.length === 0 ? (
            <EmptyState icon={<ClipboardCheck size={22} />} title="No proposals to review yet">
              Proposals appear here as soon as speakers submit them.{" "}
              <Link href="/admin/forms">Check your CFP form is published</Link> and its window is
              open.
            </EmptyState>
          ) : assignableAbstracts.length === 0 ? (
            <EmptyState icon={<ClipboardCheck size={22} />} title="No proposals ready for review">
              Every submitted proposal has reached a decision or been withdrawn. Historical
              coverage remains visible below.
            </EmptyState>
          ) : (
            <>
              {view.routingUnconfigured ? (
                <p className="hint setup-note">
                  None of your categories has a review team set, so assignments will not be tagged
                  by track. That is fine for a single review team.
                </p>
              ) : null}

              <div className="assign-grid">
                <section aria-labelledby="pick-proposals">
                  <div className="row wrap assign-toolbar">
                    <h3 id="pick-proposals">Proposals</h3>
                    <span className="spacer" />
                    <select
                      className="select-input"
                      name="proposalCategoryFilter"
                      value={categoryFilter}
                      onChange={(e) => {
                        setCategoryFilter(e.target.value);
                        setPicked(new Set());
                      }}
                      aria-label="Filter by category"
                    >
                      <option value="all">All categories</option>
                      {view.categories.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                    <label className="row" style={{ gap: 6 }}>
                      <input
                        type="checkbox"
                        name="onlyUnassigned"
                        checked={onlyUnassigned}
                        onChange={(e) => {
                          setOnlyUnassigned(e.target.checked);
                          setPicked(new Set());
                        }}
                      />
                      <span className="hint">Needs reviewers only</span>
                    </label>
                  </div>

                  <div className="row wrap" style={{ gap: 8, marginBottom: 8 }}>
                    <button
                      className="link-button"
                      type="button"
                      onClick={() => setPicked(new Set(visible.map((a) => a.id)))}
                    >
                      Select all {visible.length} shown
                    </button>
                    {picked.size > 0 ? (
                      <button className="link-button" type="button" onClick={() => setPicked(new Set())}>
                        Clear selection
                      </button>
                    ) : null}
                  </div>

                  <div className="pick-list">
                    {visible.length === 0 ? (
                      <p className="hint" style={{ padding: 12 }}>
                        No proposals match this filter.{" "}
                        {onlyUnassigned ? "Every proposal in this round already has a reviewer." : ""}
                      </p>
                    ) : (
                      visible.map((a) => {
                        const assigned = a.assignedByPlan[plan.id] ?? 0;
                        return (
                          <label className="pick-row" key={a.id}>
                            <input
                              type="checkbox"
                              name="proposalIds"
                              checked={picked.has(a.id)}
                              onChange={() => toggle(picked, a.id, setPicked)}
                            />
                            <span style={{ minWidth: 0, flex: 1 }}>
                              <span className="cell-title">{a.title}</span>
                              <span className="cell-sub">
                                {a.categoryName ?? "No category"} · {EVALUATION_SETUP_STATUS_LABELS[a.status]}
                                {a.defaultTeamKey ? ` · routes to ${a.defaultTeamKey}` : ""}
                              </span>
                            </span>
                            {assigned === 0 ? (
                              <span className="pill warn">No reviewers</span>
                            ) : (
                              <span className="hint">{assigned} assigned</span>
                            )}
                          </label>
                        );
                      })
                    )}
                  </div>
                </section>

                <section aria-labelledby="pick-reviewers">
                  <div className="assign-toolbar">
                    <h3 id="pick-reviewers">Reviewers</h3>
                  </div>
                  <div className="pick-list">
                    {view.evaluators.map((e) => (
                      <label className="pick-row" key={e.userId}>
                        <input
                          type="checkbox"
                          name="reviewerIds"
                          checked={reviewers.has(e.userId)}
                          onChange={() => toggle(reviewers, e.userId, setReviewers)}
                        />
                        <span style={{ minWidth: 0, flex: 1 }}>
                          <span className="cell-title">{e.name}</span>
                          <span className="cell-sub">
                            {e.role === "ADMIN" ? "Admin" : "Evaluator"} ·{" "}
                            {(e.loadByPlan[plan.id] ?? 0) === 0
                              ? "nothing active"
                              : `${e.loadByPlan[plan.id]} active in this round`}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>

                  <label className="stack" style={{ marginTop: 12 }}>
                    <span className="field-label">Review team (optional)</span>
                    <input
                      className="text-input"
                      name="reviewTeam"
                      autoComplete="off"
                      maxLength={120}
                      spellCheck={false}
                      value={teamKey}
                      onChange={(e) => setTeamKey(e.target.value)}
                    />
                    <span className="hint">
                      Overrides the team each proposal would inherit from its category.
                    </span>
                  </label>
                </section>
              </div>

              {error ? <p className="conflict-banner" role="alert" style={{ marginTop: 12 }}>{error}</p> : null}
              {notice ? <p className="hint setup-ok" role="status" style={{ marginTop: 12 }}>{notice}</p> : null}

              <div className="row wrap" style={{ marginTop: 14, gap: 10 }}>
                <button
                  className="primary-button"
                  type="button"
                  disabled={busy || pending || picked.size === 0 || reviewers.size === 0}
                  onClick={assign}
                >
                  {busy ? "Assigning…" : `Assign ${picked.size || "…"} to ${reviewers.size || "…"} reviewer${reviewers.size === 1 ? "" : "s"}`}
                </button>
                <span className="hint">
                  {picked.size === 0
                    ? "Pick at least one proposal."
                    : reviewers.size === 0
                      ? "Pick at least one reviewer."
                      : `${picked.size * reviewers.size} assignment combination${picked.size * reviewers.size === 1 ? "" : "s"} will be applied.`}
                </span>
              </div>
            </>
          )}
        </div>
      ) : null}

      {/* ---- Coverage ---------------------------------------------------- */}
      {plan && view.abstracts.length > 0 ? (
        <div className="card setup-section">
          <div className="setup-head">
            <h2>Review coverage — round {plan.ordinal}</h2>
            <p className="hint">
              {unassignedCount === 0
                ? "Every proposal that still needs review has at least one reviewer."
                : `${unassignedCount} proposal${unassignedCount === 1 ? "" : "s"} still need a reviewer.`}
            </p>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Proposal</th>
                  <th>Category</th>
                  <th>Status</th>
                  <th>Reviewers</th>
                  <th>Reviews done</th>
                </tr>
              </thead>
              <tbody>
                {view.abstracts.map((a) => {
                  const assigned = a.assignedByPlan[plan.id] ?? 0;
                  const done = a.completedByPlan[plan.id] ?? 0;
                  return (
                    <tr key={a.id}>
                      <td className="cell-title">{a.title}</td>
                      <td>{a.categoryName ?? <span className="muted">—</span>}</td>
                      <td>{EVALUATION_SETUP_STATUS_LABELS[a.status]}</td>
                      <td>
                        {a.status === "WITHDRAWN" && assigned > 0 ? (
                          <span className="muted">{`${assigned} archived`}</span>
                        ) : assigned === 0 && a.assignable ? (
                          <span className="programme-alert">
                            <AlertTriangle size={11} aria-hidden="true" /> None
                          </span>
                        ) : assigned === 0 ? (
                          <span className="muted">Not needed</span>
                        ) : (
                          assigned
                        )}
                      </td>
                      <td>
                        {assigned === 0 ? (
                          <span className="muted">—</span>
                        ) : a.status === "WITHDRAWN" ? (
                          `${done}/${assigned} before withdrawal`
                        ) : (
                          `${done}/${assigned}`
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {creating ? (
        <RoundDialog
          eventId={view.eventId}
          nextOrdinal={Math.max(0, ...view.plans.map((p) => p.ordinal)) + 1}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setPlanId(id);
            startTransition(() => router.refresh());
          }}
        />
      ) : null}
    </>
  );
}

/** Create a round and its rubric in one step. */
function RoundDialog({
  eventId,
  nextOrdinal,
  onClose,
  onCreated,
}: {
  eventId: string;
  nextOrdinal: number;
  onClose: () => void;
  onCreated: (planId: string) => void;
}) {
  const [name, setName] = useState(`Round ${nextOrdinal} — Program Committee`);
  const [ordinal, setOrdinal] = useState(nextOrdinal);
  const [isBlind, setIsBlind] = useState(false);
  const [criteria, setCriteria] = useState<DraftCriterion[]>(
    STARTER_CRITERIA.map((c) => ({ ...c })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Native <dialog> gives the focus trap, Esc handling and inert background for
  // free — same pattern as the CFP "New form" dialog.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  function patch(i: number, next: Partial<DraftCriterion>) {
    setCriteria((list) => list.map((c, j) => (j === i ? { ...c, ...next } : c)));
  }

  function closeDialog() {
    if (!busy) dialogRef.current?.close();
  }

  async function create() {
    const labelled = criteria.filter((c) => c.label.trim() !== "");
    if (labelled.length === 0) {
      setError("Add at least one scoring criterion.");
      return;
    }
    const bad = labelled.find((c) => c.min >= c.max);
    if (bad) {
      setError(`“${bad.label}”: the highest score must be greater than the lowest.`);
      return;
    }
    const nonIntegerRange = labelled.find((c) => !Number.isInteger(c.min) || !Number.isInteger(c.max));
    if (nonIntegerRange) {
      setError(`“${nonIntegerRange.label}”: lowest and highest scores must be whole numbers.`);
      return;
    }
    const badWeight = labelled.find((c) => !Number.isFinite(c.weight) || c.weight <= 0);
    if (badWeight) {
      setError(`“${badWeight.label}”: weight must be greater than zero.`);
      return;
    }

    setBusy(true);
    setError(null);
    const keys = uniqueRubricKeys(labelled.map((c) => c.label));
    const res = await apiPost<{ id: string }>("/api/evaluations/plans", {
      eventId,
      name: name.trim() || `Round ${ordinal}`,
      ordinal,
      isBlind,
      rubric: labelled.map((c, i) => ({
        key: keys[i],
        label: c.label.trim(),
        ...(c.description.trim() ? { description: c.description.trim() } : {}),
        min: c.min,
        max: c.max,
        weight: c.weight,
      })),
    });
    setBusy(false);
    if (!res.ok) {
      const mapped = firstFieldErrors(res.error.fieldErrors);
      setError(Object.values(mapped)[0] ?? res.error.message);
      return;
    }
    onCreated(res.data.id);
  }

  return (
    <dialog
      ref={dialogRef}
      className="app-dialog round-dialog"
      aria-label="New review round"
      onClose={onClose}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      onMouseDown={(event) => {
        if (event.target === dialogRef.current) closeDialog();
      }}
    >
      <div>
        <h2 style={{ marginTop: 0 }}>New review round</h2>
        <p className="hint">
          A round is one pass of reviewing — most events run a single round. The rubric below is
          what reviewers score against; edit it to suit your event.
        </p>

        {error ? <p className="conflict-banner" role="alert" style={{ marginTop: 12 }}>{error}</p> : null}

        <div className="grid-2" style={{ marginTop: 14 }}>
          <label className="stack">
            <span className="field-label">Round name</span>
            <input
              className="text-input"
              name="roundName"
              autoComplete="off"
              value={name}
              maxLength={160}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="stack">
            <span className="field-label">Round number</span>
            <input
              className="text-input"
              name="roundOrdinal"
              type="number"
              inputMode="numeric"
              min={1}
              value={ordinal}
              onChange={(e) => setOrdinal(Math.max(1, Math.trunc(Number(e.target.value) || 1)))}
            />
          </label>
        </div>

        <div className="row" style={{ marginTop: 14, gap: 10 }}>
          <Switch checked={isBlind} onChange={setIsBlind} label="Hide speaker profiles in reviewer queues" />
          <div>
            <span className="field-label">Blind review</span>
            <p className="hint">
              Assigned review queues hide speaker profiles. Proposal text can still identify a speaker.
            </p>
          </div>
        </div>

        <h3 style={{ margin: "20px 0 4px", fontSize: 14 }}>Scoring criteria</h3>
        <p className="hint" style={{ marginBottom: 10 }}>
          Weight decides how much a criterion counts towards the overall score.
        </p>

        {criteria.map((c, i) => (
          <div className="criterion-row" key={i}>
            <div className="criterion-main">
              <label className="stack">
                <span className="field-label">Criterion</span>
                <input
                  className="text-input"
                  name={`criterion-${i}-label`}
                  autoComplete="off"
                  maxLength={120}
                  value={c.label}
                  onChange={(e) => patch(i, { label: e.target.value })}
                />
              </label>
              <label className="stack">
                <span className="field-label">Description (optional)</span>
                <input
                  className="text-input"
                  name={`criterion-${i}-description`}
                  autoComplete="off"
                  maxLength={500}
                  value={c.description}
                  onChange={(e) => patch(i, { description: e.target.value })}
                />
              </label>
            </div>
            <label className="stack">
              <span className="field-label">Lowest</span>
              <input className="text-input" name={`criterion-${i}-min`} type="number" inputMode="numeric" step={1} value={c.min} onChange={(e) => patch(i, { min: Number(e.target.value) || 0 })} />
            </label>
            <label className="stack">
              <span className="field-label">Highest</span>
              <input className="text-input" name={`criterion-${i}-max`} type="number" inputMode="numeric" step={1} value={c.max} onChange={(e) => patch(i, { max: Number(e.target.value) || 0 })} />
            </label>
            <label className="stack">
              <span className="field-label">Weight</span>
              <input className="text-input" name={`criterion-${i}-weight`} type="number" inputMode="decimal" min={0.1} step={0.5} value={c.weight} onChange={(e) => patch(i, { weight: Number(e.target.value) || 1 })} />
            </label>
            <button
              type="button"
              className="ghost-button danger-button"
              aria-label={`Remove ${c.label || `criterion ${i + 1}`}`}
              disabled={criteria.length === 1}
              onClick={() => setCriteria((list) => list.filter((_, j) => j !== i))}
            >
              <Trash2 size={15} aria-hidden="true" />
            </button>
          </div>
        ))}

        <button
          className="ghost-button"
          type="button"
          style={{ marginTop: 8 }}
          onClick={() => setCriteria((l) => [...l, { label: "", description: "", min: 1, max: 5, weight: 1 }])}
        >
          <Plus size={15} aria-hidden="true" /> Add criterion
        </button>

        <div className="row wrap" style={{ justifyContent: "flex-end", marginTop: 22, gap: 8 }}>
          <button className="ghost-button" type="button" onClick={closeDialog} disabled={busy}>Cancel</button>
          <button className="primary-button" type="button" onClick={create} disabled={busy}>
            {busy ? "Creating…" : "Create round"}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** Small header stat block shared by the evaluations page. */
export function SetupSummary({ view, plan }: { view: EvaluationSetupView; plan: SetupPlan | null }) {
  const needing = plan
    ? view.abstracts.filter((a) => a.assignable && (a.assignedByPlan[plan.id] ?? 0) === 0).length
    : view.abstracts.filter((a) => a.assignable).length;
  return (
    <div className="metric-grid">
      <div className="metric"><span>Rounds</span><strong>{view.plans.length}</strong></div>
      <div className="metric"><span>Reviewers</span><strong>{view.evaluators.length}</strong></div>
      <div className="metric">
        <span>Proposals needing a reviewer</span>
        <strong>{needing}</strong>
      </div>
    </div>
  );
}
