"use client";

import { useMemo, useState } from "react";
import { Check, ClipboardCheck, EyeOff } from "lucide-react";
import { EVALUATION_PLAN, REVIEW_QUEUE, type QueueItem } from "@/lib/fixtures";
import { Pill } from "@/components/ui";

const STATUS_TONE: Record<QueueItem["status"], string> = {
  ASSIGNED: "info",
  IN_PROGRESS: "warn",
  COMPLETED: "good",
};

export function EvaluationWorkspace() {
  const plan = EVALUATION_PLAN;
  const [queue, setQueue] = useState<QueueItem[]>(REVIEW_QUEUE);
  const [activeId, setActiveId] = useState(REVIEW_QUEUE.find((q) => q.status !== "COMPLETED")?.abstractId ?? REVIEW_QUEUE[0].abstractId);
  const [comment, setComment] = useState("");

  const active = queue.find((q) => q.abstractId === activeId)!;
  const scores = active.myScores ?? {};

  const completed = queue.filter((q) => q.status === "COMPLETED").length;
  const progress = Math.round((completed / queue.length) * 100);

  const weightedTotal = useMemo(() => {
    let sum = 0;
    let wsum = 0;
    for (const c of plan.rubric) {
      if (scores[c.key] !== undefined) {
        sum += scores[c.key] * c.weight;
        wsum += c.weight;
      }
    }
    return wsum ? (sum / wsum).toFixed(2) : "—";
  }, [scores, plan.rubric]);

  const allScored = plan.rubric.every((c) => scores[c.key] !== undefined);

  function setScore(key: string, value: number) {
    setQueue((qs) =>
      qs.map((q) =>
        q.abstractId === activeId
          ? { ...q, status: q.status === "COMPLETED" ? "COMPLETED" : "IN_PROGRESS", myScores: { ...(q.myScores ?? {}), [key]: value } }
          : q,
      ),
    );
  }

  function submitScores() {
    setQueue((qs) => qs.map((q) => (q.abstractId === activeId ? { ...q, status: "COMPLETED" } : q)));
    setComment("");
    const nextItem = queue.find((q) => q.status !== "COMPLETED" && q.abstractId !== activeId);
    if (nextItem) setActiveId(nextItem.abstractId);
  }

  return (
    <div className="eval-grid">
      {/* queue */}
      <div className="card">
        <div style={{ padding: "16px 16px 12px", borderBottom: "1px solid var(--line)" }}>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
            <strong>{plan.name}</strong>
            {plan.isBlind ? <Pill tone="neutral"><EyeOff size={12} /> Blind</Pill> : null}
          </div>
          <div className="progress-bar" aria-label={`${progress}% complete`}><span style={{ width: `${progress}%` }} /></div>
          <p className="hint" style={{ marginTop: 6 }}>{completed} of {queue.length} in your queue scored</p>
        </div>
        <div role="list" aria-label="Review queue">
          {queue.map((item) => (
            <button
              key={item.abstractId}
              role="listitem"
              className={`queue-item ${item.abstractId === activeId ? "active" : ""}`}
              onClick={() => setActiveId(item.abstractId)}
            >
              <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                <h3>{plan.isBlind ? `Submission ${item.abstractId.replace("abs_", "#")}` : item.title}</h3>
                <Pill tone={STATUS_TONE[item.status]}>
                  {item.status === "COMPLETED" ? <Check size={11} /> : null}
                  {item.status === "ASSIGNED" ? "To do" : item.status === "IN_PROGRESS" ? "In progress" : "Done"}
                </Pill>
              </div>
              <p className="hint">{item.categoryName} · {item.teamKey}</p>
            </button>
          ))}
        </div>
      </div>

      {/* scoring */}
      <div className="card" style={{ padding: 24 }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
          <p className="eyebrow">Now scoring · {active.teamKey}</p>
          <span className="hint">Weighted score: <strong>{weightedTotal}</strong></span>
        </div>
        <h2 style={{ margin: "0 0 6px" }}>{plan.isBlind ? `Submission ${active.abstractId.replace("abs_", "#")}` : active.title}</h2>
        <p className="hint">{active.categoryName}{plan.isBlind ? " · Speaker identity hidden (blind review)" : ""}</p>

        <div style={{ marginTop: 16 }}>
          {plan.rubric.map((c) => (
            <div className="rubric-row" key={c.key}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <span className="field-label">{c.label}</span>
                  {c.weight !== 1 ? <span className="hint"> · weight {c.weight}</span> : null}
                  {c.description ? <p className="hint">{c.description}</p> : null}
                </div>
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
        </label>

        <div className="row" style={{ marginTop: 16, gap: 10 }}>
          <button className="primary-button" type="button" disabled={!allScored} onClick={submitScores} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            <ClipboardCheck size={16} /> {active.status === "COMPLETED" ? "Update review" : "Submit review"}
          </button>
          {!allScored ? <span className="hint">Score every criterion to submit.</span> : null}
        </div>
      </div>
    </div>
  );
}
