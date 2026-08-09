"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, CalendarPlus, FileStack, Search, Star, X } from "lucide-react";
import type { AbstractRow } from "@/lib/data/reads";
import { formatAnswer } from "@/lib/answer-display";
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

/**
 * How far a proposal has travelled towards the public programme. Deliberately
 * phrased the way an event producer would say it, not after the data model:
 * "talk" not "Session", "programme" not "ScheduleSlot".
 */
type ProgrammeState = "none" | "created" | "scheduled";

function programmeState(a: Pick<AbstractRow, "hasSession" | "sessionScheduled">): ProgrammeState {
  if (!a.hasSession) return "none";
  return a.sessionScheduled ? "scheduled" : "created";
}

/**
 * A declined or withdrawn proposal whose talk is still on the programme.
 * INV-DOMAIN-001 keeps the confirmed talk as the record of truth, so nothing is
 * deleted automatically — which means the admin has to be told.
 */
function isProgrammeMismatch(a: Pick<AbstractRow, "hasSession" | "status">): boolean {
  return a.hasSession && (a.status === "REJECTED" || a.status === "WITHDRAWN");
}

type ProgrammeWarning = { title: string; state: ProgrammeState };

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
  // Lifted out of the drawer on purpose: the drawer closes on a backdrop click,
  // and this consequence is too easy to miss if it disappears with it.
  const [warning, setWarning] = useState<ProgrammeWarning | null>(null);

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
      {warning ? (
        <div style={{ padding: 12 }}>
          <div className="conflict-banner" role="alert">
            <AlertTriangle size={17} aria-hidden="true" />
            <div>
              <strong>“{warning.title}” is still on the programme.</strong>{" "}
              {warning.state === "scheduled"
                ? "Declining the proposal does not take the talk off the schedule. Open the agenda builder to remove it."
                : "A talk had already been created from this proposal. Declining does not delete it — remove it in the agenda builder if it should not run."}
              <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
                <Link className="ghost-button" href="/admin/agenda">Open agenda builder</Link>
                <button type="button" className="link-button" onClick={() => setWarning(null)}>Dismiss</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

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
                      {isProgrammeMismatch(a) ? (
                        <div className="cell-sub programme-alert">
                          <AlertTriangle size={11} aria-hidden="true" /> Still on the programme
                        </div>
                      ) : a.sessionScheduled ? (
                        <div className="cell-sub">On the programme</div>
                      ) : a.hasSession ? (
                        <div className="cell-sub">Talk created</div>
                      ) : null}
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

      {selected ? (
        <AbstractDrawer
          abstract={selected}
          onClose={() => setSelectedId(null)}
          onProgrammeWarning={setWarning}
        />
      ) : null}
    </div>
  );
}

function AbstractDrawer({
  abstract,
  onClose,
  onProgrammeWarning,
}: {
  abstract: AbstractRow;
  onClose: () => void;
  onProgrammeWarning: (warning: ProgrammeWarning) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<null | "accept" | "reject" | "convert">(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);

  const meta = STATUS_META[abstract.status];
  const state = programmeState(abstract);
  const undecided = abstract.status === "UNDER_REVIEW" || abstract.status === "SUBMITTED";
  // A decision is reversible: programmes change, speakers drop out. Hiding the
  // reversal was a dead end, and it is also the only route by which a decision
  // can affect an already-scheduled talk.
  const isDecided = abstract.status === "ACCEPTED" || abstract.status === "REJECTED";
  const canDecide = undecided || (isDecided && changing);
  const canConvert = abstract.status === "ACCEPTED" && !abstract.hasSession;

  const PROGRAMME_LABEL: Record<ProgrammeState, string> = {
    none: "No talk created yet",
    created: "Talk created, not scheduled",
    scheduled: "On the programme",
  };

  async function decide(decision: "ACCEPTED" | "REJECTED") {
    if (decision === "REJECTED") {
      // Spell out the consequence BEFORE the click, not only after it.
      const consequence =
        state === "scheduled"
          ? `\n\nThis talk is on the schedule. Declining will not take it off the programme — you will also need to unschedule it in the agenda builder.`
          : state === "created"
            ? `\n\nA talk has already been created from this proposal. Declining will not delete it.`
            : "";
      if (!window.confirm(`Decline “${abstract.title}”?${consequence}`)) return;
    }
    setBusy(decision === "ACCEPTED" ? "accept" : "reject");
    setError(null);
    // `sessionId` is the W2 backend addition; until it ships, fall back to the
    // linkage this page already read server-side. Either way the check holds.
    const res = await apiPost<{ sessionId?: string | null; session?: { id: string } | null }>("/api/evaluations/decisions", {
      abstractId: abstract.id,
      decision,
    });
    setBusy(null);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    const linkedSessionId = res.data?.sessionId ?? res.data?.session?.id ?? abstract.sessionId;
    setChanging(false);
    if (decision === "REJECTED" && linkedSessionId) {
      onProgrammeWarning({ title: abstract.title, state: state === "none" ? "created" : state });
      setNotice(null);
      onClose();
    } else {
      setNotice(decision === "ACCEPTED" ? "Accepted." : "Declined.");
    }
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
          <div className="kv">
            <span>Programme</span>
            <span className={isProgrammeMismatch(abstract) ? "programme-alert" : undefined}>
              {isProgrammeMismatch(abstract) ? (
                <>
                  <AlertTriangle size={12} aria-hidden="true" /> Still on the programme
                </>
              ) : (
                PROGRAMME_LABEL[state]
              )}
            </span>
          </div>
        </div>

        <SubmissionAnswers abstract={abstract} />

        {isProgrammeMismatch(abstract) ? (
          <p className="hint" style={{ marginTop: 10 }}>
            {abstract.status === "WITHDRAWN"
              ? "This proposal was withdrawn, but its talk is still on the programme. "
              : "This proposal was declined, but its talk is still on the programme. "}
            <Link href="/admin/agenda">Open the agenda builder</Link> to take it off the schedule
            {abstract.status === "REJECTED"
              ? ", or change the decision back to accepted if it should run after all."
              : "."}
          </p>
        ) : null}

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
          {isDecided && !changing && (
            <button className="ghost-button" disabled={busy !== null || pending} onClick={() => setChanging(true)}>
              Change decision
            </button>
          )}
          {isDecided && changing && (
            <button className="link-button" disabled={busy !== null || pending} onClick={() => setChanging(false)}>
              Keep “{meta.label.toLowerCase()}”
            </button>
          )}
          {canConvert && (
            <button className="primary-button" disabled={busy !== null || pending} onClick={convert} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
              <CalendarPlus size={16} /> {busy === "convert" ? "Creating…" : "Create session"}
            </button>
          )}
          {abstract.sessionScheduled ? (
            <span className="hint">This talk is on the schedule — change it in the agenda builder.</span>
          ) : abstract.hasSession ? (
            <span className="hint">Talk created — schedule it in the agenda builder.</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * What the speaker actually filled in on the CFP form. Previously missing
 * entirely, so an admin reviewing a proposal could not see any of the custom
 * questions their own form asked.
 */
function SubmissionAnswers({ abstract }: { abstract: AbstractRow }) {
  const answered = abstract.answers.filter((a) => !formatAnswer(a.value, a).empty);

  return (
    <section style={{ marginTop: 18 }} aria-labelledby="submission-answers-heading">
      <h3 id="submission-answers-heading" style={{ fontSize: 13, margin: "0 0 8px" }}>
        Form answers
        {abstract.answers.length > 0 ? (
          <span className="hint" style={{ fontWeight: 400 }}> · {answered.length} of {abstract.answers.length} answered</span>
        ) : null}
      </h3>

      {abstract.answersUnavailable ? (
        <p className="hint">
          This event stores too many answers to load them all on this page. Open the proposal in
          the CFP form to review it.
        </p>
      ) : abstract.answers.length === 0 ? (
        <p className="hint">
          This proposal has no extra answers — “{abstract.formName}” only asked for the title,
          summary and speakers.
        </p>
      ) : (
        <dl className="answer-list">
          {abstract.answers.map((a) => {
            const formatted = formatAnswer(a.value, a);
            return (
              <div className="answer-item" key={a.fieldId}>
                <dt>{a.label}</dt>
                <dd className={formatted.empty ? "muted" : undefined}>
                  {formatted.isUrl ? (
                    <a href={formatted.text} target="_blank" rel="noopener noreferrer nofollow">
                      {formatted.text}
                    </a>
                  ) : (
                    formatted.text
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </section>
  );
}
