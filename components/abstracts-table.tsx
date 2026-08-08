"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, FileStack, Search, Star, X } from "lucide-react";
import type { AbstractRow } from "@/lib/data/reads";
import { apiPost } from "@/lib/api-client";
import { EmptyState, Pill } from "@/components/ui";

const STATUS_META: Record<string, { label: string; tone: string }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  SUBMITTED: { label: "Submitted", tone: "info" },
  UNDER_REVIEW: { label: "Under review", tone: "warn" },
  ACCEPTED: { label: "Accepted", tone: "good" },
  REJECTED: { label: "Declined", tone: "bad" },
  WITHDRAWN: { label: "Withdrawn", tone: "neutral" },
};

const TABS: { key: string; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "SUBMITTED", label: "Submitted" },
  { key: "UNDER_REVIEW", label: "Under review" },
  { key: "ACCEPTED", label: "Accepted" },
  { key: "REJECTED", label: "Declined" },
  { key: "DRAFT", label: "Drafts" },
];

export function AbstractsTable({ abstracts }: { abstracts: AbstractRow[] }) {
  const [tab, setTab] = useState("ALL");
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: abstracts.length };
    for (const a of abstracts) c[a.status] = (c[a.status] ?? 0) + 1;
    return c;
  }, [abstracts]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return abstracts
      .filter((a) => (tab === "ALL" ? true : a.status === tab))
      .filter(
        (a) =>
          !needle ||
          a.title.toLowerCase().includes(needle) ||
          a.speakers.some((s) => s.name.toLowerCase().includes(needle)),
      );
  }, [abstracts, tab, q]);

  const selected = abstracts.find((a) => a.id === selectedId) ?? null;

  return (
    <div className="card">
      <div style={{ padding: "6px 8px 0" }}>
        <div className="tabs" role="group" aria-label="Abstract status">
          {TABS.map((t) => (
            <button key={t.key} aria-pressed={tab === t.key} className="tab" onClick={() => setTab(t.key)}>
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
        <span className="hint">{rows.length} of {abstracts.length}</span>
      </div>

      {abstracts.length === 0 ? (
        <EmptyState icon={<FileStack size={22} />} title="No submissions yet">
          Abstracts appear here once speakers submit through a published CFP form.
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState icon={<FileStack size={22} />} title="No abstracts match">
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
                <th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const meta = STATUS_META[a.status];
                return (
                  <tr key={a.id}>
                    <td>
                      <Pill tone={meta.tone}>{meta.label}</Pill>
                      {a.hasSession ? <div className="cell-sub">Session created</div> : null}
                    </td>
                    <td>
                      <div className="cell-title">{a.title}</div>
                      <div className="cell-sub">{a.format ?? "—"}</div>
                    </td>
                    <td>{a.categoryName ?? <span className="muted">—</span>}</td>
                    <td>
                      {a.speakers.find((s) => s.isPrimary)?.name ?? a.speakers[0]?.name ?? "—"}
                      {a.speakers.length > 1 ? <div className="cell-sub">+{a.speakers.length - 1} co-speaker</div> : null}
                    </td>
                    <td>
                      {a.reviewsTotal > 0 ? `${a.reviewsComplete}/${a.reviewsTotal}` : <span className="muted">—</span>}
                    </td>
                    <td>
                      {a.avgScore !== null ? (
                        <span className="row" style={{ gap: 4 }}>
                          <Star size={13} fill="#e8a13a" color="#e8a13a" /> {a.avgScore.toFixed(1)}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td><button type="button" className="link-button" onClick={() => setSelectedId(a.id)}>View</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected ? <AbstractDrawer abstract={selected} onClose={() => setSelectedId(null)} /> : null}
    </div>
  );
}

function AbstractDrawer({ abstract, onClose }: { abstract: AbstractRow; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<null | "accept" | "reject" | "convert">(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const meta = STATUS_META[abstract.status];
  const canDecide = abstract.status === "UNDER_REVIEW" || abstract.status === "SUBMITTED";
  const canConvert = abstract.status === "ACCEPTED" && !abstract.hasSession;

  async function decide(decision: "ACCEPTED" | "REJECTED") {
    if (decision === "REJECTED" && !window.confirm(`Decline “${abstract.title}”? This changes the submission decision.`)) return;
    setBusy(decision === "ACCEPTED" ? "accept" : "reject");
    setError(null);
    const res = await apiPost("/api/evaluations/decisions", { abstractId: abstract.id, decision });
    setBusy(null);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setNotice(decision === "ACCEPTED" ? "Accepted." : "Declined.");
    startTransition(() => router.refresh());
  }

  async function convert() {
    setBusy("convert");
    setError(null);
    const res = await apiPost<{ sessionId: string; created: boolean }>("/api/evaluations/convert", {
      abstractId: abstract.id,
      durationMinutes: abstract.durationMinutes ?? 30,
    });
    setBusy(null);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setNotice(res.data.created ? "Session created — schedule it on the agenda." : "Session already existed.");
    startTransition(() => router.refresh());
  }

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
        {abstract.abstract ? <p style={{ lineHeight: 1.6 }}>{abstract.abstract}</p> : <p className="muted">No abstract body provided.</p>}

        <div className="detail-drawer">
          <div className="kv"><span>Form</span><span>{abstract.formName}</span></div>
          <div className="kv"><span>Category</span><span>{abstract.categoryName ?? "—"}</span></div>
          <div className="kv"><span>Format</span><span>{abstract.format ?? "—"}</span></div>
          <div className="kv"><span>Duration</span><span>{abstract.durationMinutes ? `${abstract.durationMinutes} min` : "—"}</span></div>
          <div className="kv">
            <span>Speakers</span>
            <span>{abstract.speakers.map((s) => `${s.name}${s.isPrimary ? " (primary)" : ""}`).join(", ") || "—"}</span>
          </div>
          <div className="kv"><span>Reviews</span><span>{abstract.reviewsTotal > 0 ? `${abstract.reviewsComplete}/${abstract.reviewsTotal} complete` : "Not assigned"}</span></div>
          <div className="kv"><span>Avg score</span><span>{abstract.avgScore !== null ? abstract.avgScore.toFixed(2) : "Not scored"}</span></div>
          <div className="kv"><span>Submitted</span><span>{abstract.submittedAt ? new Date(abstract.submittedAt).toLocaleString() : "—"}</span></div>
        </div>

        {error ? <p className="field-error" style={{ marginTop: 12 }} role="alert">{error}</p> : null}
        {notice ? <p className="hint" style={{ marginTop: 12, color: "var(--brand-strong)" }} role="status">{notice}</p> : null}

        <div className="row wrap" style={{ marginTop: 16, gap: 8 }}>
          {canDecide && (
            <>
              <button className="primary-button" disabled={busy !== null || pending} onClick={() => decide("ACCEPTED")}>
                {busy === "accept" ? "Accepting…" : "Accept"}
              </button>
              <button className="ghost-button danger-button" disabled={busy !== null || pending} onClick={() => decide("REJECTED")}>
                {busy === "reject" ? "Declining…" : "Decline"}
              </button>
            </>
          )}
          {canConvert && (
            <button className="primary-button" disabled={busy !== null || pending} onClick={convert} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
              <CalendarPlus size={16} /> {busy === "convert" ? "Creating…" : "Create session"}
            </button>
          )}
          {abstract.hasSession ? <span className="hint">Session exists — schedule it in the agenda builder.</span> : null}
        </div>
      </div>
    </div>
  );
}
