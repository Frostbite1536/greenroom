"use client";

import { useMemo, useState } from "react";
import { FileStack, Search, Star, X } from "lucide-react";
import { ABSTRACTS, ABSTRACT_STATUS_META, type AbstractModel, type Status } from "@/lib/fixtures";
import { EmptyState, Pill } from "@/components/ui";

const TABS: { key: Status | "ALL"; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "SUBMITTED", label: "Submitted" },
  { key: "UNDER_REVIEW", label: "Under review" },
  { key: "ACCEPTED", label: "Accepted" },
  { key: "REJECTED", label: "Declined" },
  { key: "DRAFT", label: "Drafts" },
];

export function AbstractsTable() {
  const [tab, setTab] = useState<Status | "ALL">("ALL");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<AbstractModel | null>(null);

  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: ABSTRACTS.length };
    for (const a of ABSTRACTS) c[a.status] = (c[a.status] ?? 0) + 1;
    return c;
  }, []);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return ABSTRACTS.filter((a) => (tab === "ALL" ? true : a.status === tab)).filter(
      (a) => !needle || a.title.toLowerCase().includes(needle) || a.speakers.some((s) => s.name.toLowerCase().includes(needle)),
    );
  }, [tab, q]);

  return (
    <div className="card">
      <div style={{ padding: "6px 8px 0" }}>
        <div className="tabs" role="tablist" aria-label="Abstract status">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className="tab"
              onClick={() => setTab(t.key)}
            >
              {t.label} <span className="count">{counts[t.key] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="table-toolbar">
        <span className="row" style={{ gap: 8, flex: 1, minWidth: 180 }}>
          <Search size={15} className="muted" aria-hidden="true" />
          <input
            className="text-input search-input"
            style={{ border: "none", padding: "6px 0" }}
            placeholder="Search abstracts or speakers…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search abstracts"
          />
        </span>
        <span className="hint">{rows.length} of {ABSTRACTS.length}</span>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={<FileStack size={22} />} title="No abstracts here">
          Try a different status filter or clear your search.
        </EmptyState>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Title</th>
                <th>Category</th>
                <th>Speakers</th>
                <th>Reviews</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const meta = ABSTRACT_STATUS_META[a.status];
                return (
                  <tr key={a.id} onClick={() => setSelected(a)} style={{ cursor: "pointer" }}>
                    <td><Pill tone={meta.tone}>{meta.label}</Pill></td>
                    <td>
                      <div className="cell-title">{a.title}</div>
                      <div className="cell-sub">{a.format}</div>
                    </td>
                    <td>{a.categoryName}</td>
                    <td>
                      {a.speakers.map((s) => s.name).join(", ")}
                      {a.speakers.length > 1 ? <div className="cell-sub">+{a.speakers.length - 1} co-speaker</div> : null}
                    </td>
                    <td>{a.reviewsComplete}/{a.reviewsTotal}</td>
                    <td>
                      {a.avgScore ? (
                        <span className="row" style={{ gap: 4 }}><Star size={13} fill="#e8a13a" color="#e8a13a" /> {a.avgScore.toFixed(1)}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected ? <AbstractDrawer abstract={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

function AbstractDrawer({ abstract, onClose }: { abstract: AbstractModel; onClose: () => void }) {
  const meta = ABSTRACT_STATUS_META[abstract.status];
  const canAccept = abstract.status === "UNDER_REVIEW" || abstract.status === "SUBMITTED";
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={abstract.title}
      style={{ position: "fixed", inset: 0, background: "rgba(20,28,30,0.35)", display: "flex", justifyContent: "flex-end", zIndex: 50 }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: "min(480px, 100%)", height: "100%", borderRadius: 0, overflowY: "auto", padding: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <Pill tone={meta.tone}>{meta.label}</Pill>
          <button className="ghost-button" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <h2 style={{ marginTop: 0 }}>{abstract.title}</h2>
        <p style={{ lineHeight: 1.6 }}>{abstract.abstract}</p>
        <div className="detail-drawer">
          <div className="kv"><span>Category</span><span>{abstract.categoryName}</span></div>
          <div className="kv"><span>Format</span><span>{abstract.format}</span></div>
          <div className="kv"><span>Speakers</span><span>{abstract.speakers.map((s) => `${s.name}${s.isPrimary ? " (primary)" : ""}`).join(", ")}</span></div>
          <div className="kv"><span>Reviews</span><span>{abstract.reviewsComplete}/{abstract.reviewsTotal} complete</span></div>
          <div className="kv"><span>Avg score</span><span>{abstract.avgScore ? abstract.avgScore.toFixed(1) : "Not scored"}</span></div>
          <div className="kv"><span>Submitted</span><span>{abstract.submittedAt ? new Date(abstract.submittedAt).toLocaleString() : "—"}</span></div>
        </div>
        {canAccept ? (
          <div className="row" style={{ marginTop: 16, gap: 8 }}>
            <button className="primary-button">Accept → create session</button>
            <button className="ghost-button danger-button">Decline</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
