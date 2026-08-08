"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ClipboardCheck, EyeOff, Inbox } from "lucide-react";
import type { EvaluationView, QueueRow } from "@/lib/data/reads";
import { apiPost } from "@/lib/api-client";
import { EmptyState, Pill } from "@/components/ui";

const STATUS_TONE: Record<string, string> = {
  ASSIGNED: "info",
  IN_PROGRESS: "warn",
  COMPLETED: "good",
  DECLINED: "neutral",
};
const STATUS_LABEL: Record<string, string> = {
  ASSIGNED: "To do",
  IN_PROGRESS: "In progress",
  COMPLETED: "Done",
  DECLINED: "Declined",
};

export function EvaluationWorkspace({ view }: { view: EvaluationView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [activeId, setActiveId] = useState<string | null>(
    view.queue.find((q) => q.status !== "COMPLETED")?.abstractId ?? view.queue[0]?.abstractId ?? null,
  );
  // Local score edits layered over the server state, keyed by abstract id.
  const [edits, setEdits] = useState<Record<string, Record<string, number>>>({});
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // NOTE: every hook must run before the early returns below. `weightedTotal`
  // used to sit after them, so a queue going from empty to non-empty without a
  // remount changed the hook count and would crash the workspace.
  const plan = view.plan;
  // Explicitly annotated: without `noUncheckedIndexedAccess`, `queue[0]` types as
  // QueueRow even when the queue is empty, which would hide the null case from
  // the compiler while it still happens at runtime.
  const active: QueueRow | null =
    view.queue.find((q) => q.abstractId === activeId) ?? view.queue[0] ?? null;
  const scores = active ? { ...active.myScores, ...(edits[active.abstractId] ?? {}) } : {};

  const weightedTotal = useMemo(() => {
    let sum = 0;
    let wsum = 0;
    for (const c of plan?.rubric ?? []) {
      const v = scores[c.key];
      if (v !== undefined) {
        sum += v * c.weight;
        wsum += c.weight;
      }
    }
    return wsum ? (sum / wsum).toFixed(2) : "—";
  }, [scores, plan]);

  if (!plan) {
    return (
      <div className="card">
        <EmptyState icon={<Inbox size={22} />} title="No evaluation round yet">
          An admin needs to create a review round before scoring can start.
        </EmptyState>
      </div>
    );
  }

  if (!active) {
    return (
      <div className="card">
        <EmptyState icon={<Inbox size={22} />} title="Nothing assigned to you">
          {view.role === "ADMIN"
            ? "You have no review assignments in this round. Assign proposals to yourself in the panel above, or sign in with the Evaluator persona to see a populated scoring queue."
            : "You have no review assignments in this round yet. Check back once the program team assigns proposals."}
        </EmptyState>
      </div>
    );
  }

  const completed = view.queue.filter((q) => q.status === "COMPLETED").length;
  const progress = Math.round((completed / view.queue.length) * 100);

  // A speaker can withdraw mid-review (W1); scoring one is refused server-side
  // with 409 ABSTRACT_WITHDRAWN, so the form must not invite the attempt.
  const withdrawn = active.abstractStatus === "WITHDRAWN";
  const allScored = plan.rubric.every((c) => scores[c.key] !== undefined);

  function setScore(key: string, value: number) {
    if (!active) return;
    setEdits((e) => ({
      ...e,
      [active.abstractId]: { ...(e[active.abstractId] ?? {}), [key]: value },
    }));
    setNotice(null);
  }

  function selectRow(row: QueueRow) {
    setActiveId(row.abstractId);
    setComment("");
    setError(null);
    setNotice(null);
  }

  async function submitScores() {
    // Declared above the early returns, so it cannot rely on their narrowing.
    if (!plan || !active) return;
    setBusy(true);
    setError(null);
    const res = await apiPost("/api/evaluations/scores", {
      planId: plan.id,
      abstractId: active.abstractId,
      scores: plan.rubric.map((c) => ({
        rubricKey: c.key,
        score: scores[c.key],
        ...(comment.trim() && c.key === plan.rubric[0].key ? { comment: comment.trim() } : {}),
      })),
      complete: true,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setNotice("Review submitted.");
    setComment("");
    const nextRow = view.queue.find((q) => q.status !== "COMPLETED" && q.abstractId !== active.abstractId);
    if (nextRow) setActiveId(nextRow.abstractId);
    startTransition(() => router.refresh());
  }

  return (
    <div className="eval-grid">
      <div className="card">
        <div style={{ padding: "16px 16px 12px", borderBottom: "1px solid var(--line)" }}>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
            <strong>{plan.name}</strong>
            {plan.isBlind ? <Pill tone="neutral"><EyeOff size={12} /> Blind</Pill> : null}
          </div>
          <div className="progress-bar" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Your review progress">
            <span style={{ width: `${progress}%` }} />
          </div>
          <p className="hint" style={{ marginTop: 6 }}>{completed} of {view.queue.length} in your queue scored</p>
        </div>
        <div>
          {view.queue.map((item) => (
            <button
              key={item.abstractId}
              className={`queue-item ${item.abstractId === active.abstractId ? "active" : ""}`}
              onClick={() => selectRow(item)}
              aria-current={item.abstractId === active.abstractId}
            >
              <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                <h3>{item.title}</h3>
                <Pill tone={item.abstractStatus === "WITHDRAWN" ? "neutral" : STATUS_TONE[item.status]}>
                  {item.abstractStatus === "WITHDRAWN" ? "Withdrawn" : (
                    <>
                      {item.status === "COMPLETED" ? <Check size={11} /> : null}
                      {STATUS_LABEL[item.status]}
                    </>
                  )}
                </Pill>
              </div>
              <p className="hint">
                {item.categoryName ?? "Uncategorised"}
                {item.teamKey ? ` · ${item.teamKey}` : ""}
              </p>
            </button>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: 24 }}>
        <div className="row wrap" style={{ justifyContent: "space-between", marginBottom: 4 }}>
          <p className="eyebrow">Now scoring{active.teamKey ? ` · ${active.teamKey}` : ""}</p>
          <span className="hint">Weighted score: <strong>{weightedTotal}</strong></span>
        </div>
        <h2 style={{ margin: "0 0 6px" }}>{active.title}</h2>
        <p className="hint">
          {active.categoryName ?? "Uncategorised"}
          {plan.isBlind && active.speakers.length === 0
            ? " · Speaker identity hidden (blind review)"
            : active.speakers.length > 0
              ? ` · ${active.speakers.join(", ")}`
              : ""}
        </p>
        {active.abstractBody ? (
          <p style={{ lineHeight: 1.6, marginTop: 12 }}>{active.abstractBody}</p>
        ) : (
          <p className="muted" style={{ marginTop: 12 }}>No abstract body provided.</p>
        )}

        {withdrawn ? (
          <p className="setup-note" role="status" style={{ marginTop: 16 }}>
            The speaker withdrew this proposal, so it no longer needs a review. Pick another one
            from your queue.
          </p>
        ) : null}

        <div style={{ marginTop: 16 }}>
          {plan.rubric.map((c) => (
            <div className="rubric-row" key={c.key}>
              <div>
                <span className="field-label">{c.label}</span>
                {c.weight !== 1 ? <span className="hint"> · weight {c.weight}</span> : null}
                {c.description ? <p className="hint">{c.description}</p> : null}
              </div>
              <div className="score-buttons" role="radiogroup" aria-label={c.label}>
                {Array.from({ length: c.max - c.min + 1 }, (_, i) => c.min + i).map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={scores[c.key] === n}
                    className={`score-btn ${scores[c.key] === n ? "selected" : ""}`}
                    onClick={() => setScore(c.key, n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <label className="stack" style={{ marginTop: 8 }}>
          <span className="field-label">Comments (optional)</span>
          <textarea className="text-input" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Feedback for the program committee…" />
          {active.myComment && !comment ? <span className="hint">Previously: “{active.myComment}”</span> : null}
        </label>

        {error ? <p className="field-error" style={{ marginTop: 12 }} role="alert">{error}</p> : null}
        {notice ? <p className="hint" style={{ marginTop: 12, color: "var(--brand-strong)" }} role="status">{notice}</p> : null}

        <div className="row wrap" style={{ marginTop: 16, gap: 10 }}>
          <button className="primary-button" type="button" disabled={withdrawn || !allScored || busy || pending} onClick={submitScores} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            <ClipboardCheck size={16} />
            {busy ? "Saving…" : active.status === "COMPLETED" ? "Update review" : "Submit review"}
          </button>
          {withdrawn ? (
            <span className="hint">This proposal was withdrawn — no review needed.</span>
          ) : !allScored ? (
            <span className="hint">Score every criterion to submit.</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
