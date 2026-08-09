"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Lock, Plus, X } from "lucide-react";
import { FieldControl, type RenderField } from "@/components/field-renderer";
import { resolveVisibleFields, type AnswerMap, type AnswerValue } from "@/lib/form-logic";
import {
  canRequestWithdrawal,
  editSavedNotice,
  editScopeNotice,
  submissionActionLabel,
  submissionErrorMessage,
  submissionStatusView,
  withdrawalSuccessNotice,
  withdrawalUnavailableNotice,
} from "@/lib/portal/submission-status";
import styles from "../../portal.module.css";

/**
 * Speaker-facing edit surface for one submission (R1).
 *
 * Reads and writes the backend-owned contract at
 * `GET|PATCH /api/cfp/submissions/{abstractId}`. It fetches from the browser on
 * purpose: cookies attach automatically, and the response already carries the
 * form spec, so the portal never re-derives CFP rules that belong to the
 * backend. `FieldControl` is the same control the public CFP renders, so a
 * speaker edits the questions in the shape they answered them.
 */
type Speaker = { email: string; name: string; isPrimary: boolean };

type Submission = {
  id: string;
  title: string;
  abstract: string | null;
  format: string | null;
  durationMinutes: number | null;
  categoryId: string | null;
  status: string;
  speakers: Speaker[];
  canEdit: boolean;
  lockReason: string | null;
  speakersLocked: boolean;
  isScheduled?: boolean;
  form?: { name?: string };
};

type FormSpec = {
  name: string;
  minSpeakers: number;
  maxSpeakers: number;
  maxBioLength: number;
  fields: RenderField[];
  categories: { id: string; name: string }[];
};

type Loaded = { submission: Submission; answersByKey: AnswerMap; form: FormSpec };

export function SubmissionEditor({ abstractId }: { abstractId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [abstract, setAbstract] = useState("");
  const [format, setFormat] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [withdrawn, setWithdrawn] = useState(false);
  const [busyAction, setBusyAction] = useState<"save" | "withdraw" | null>(null);

  function hydrate(data: Loaded) {
    setLoaded(data);
    setTitle(data.submission.title ?? "");
    setAbstract(data.submission.abstract ?? "");
    setFormat(data.submission.format ?? "");
    setDurationMinutes(data.submission.durationMinutes ? String(data.submission.durationMinutes) : "");
    setCategoryId(data.submission.categoryId ?? "");
    setAnswers({ ...data.answersByKey });
    setSpeakers(data.submission.speakers.map((speaker) => ({ ...speaker })));
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/cfp/submissions/${abstractId}`);
        const body = await res.json();
        if (cancelled) return;
        if (!body?.ok) {
          setLoadError(submissionErrorMessage(body?.error?.code ?? "UNKNOWN", body?.error?.message));
          return;
        }
        hydrate(body.data as Loaded);
      } catch (error) {
        console.warn("Submission load failed", error);
        if (!cancelled) setLoadError(submissionErrorMessage("NETWORK_ERROR"));
      }
    })();
    return () => { cancelled = true; };
  }, [abstractId]);

  const visibleFields = useMemo(
    () => resolveVisibleFields(loaded?.form.fields ?? [], answers),
    [loaded, answers],
  );

  if (loadError) {
    return (
      <section className={styles.card}>
        <p className={styles.saveError}>{loadError}</p>
        <Link className="ghost-button" href="/portal"><ArrowLeft size={15} aria-hidden="true" /> Back to your portal</Link>
      </section>
    );
  }
  if (!loaded) {
    return <section className={styles.card}><p className={styles.empty} role="status">Loading your proposal…</p></section>;
  }

  const { submission, form } = loaded;
  const view = submissionStatusView(submission.status);
  const readOnly = !submission.canEdit;
  // The backend allows roster edits right up until the talk becomes a session.
  const rosterEditable = !readOnly && !submission.speakersLocked;
  const canWithdraw = canRequestWithdrawal(submission.status, submission.speakersLocked);
  const withdrawUnavailable = withdrawalUnavailableNotice(submission.status, submission.speakersLocked);

  function updateSpeaker(index: number, patch: Partial<Speaker>) {
    setSpeakers((current) => current.map((speaker, i) => (i === index ? { ...speaker, ...patch } : speaker)));
  }

  function makePrimary(index: number) {
    // Exactly one primary: the contract refuses a roster with none or several.
    setSpeakers((current) => current.map((speaker, i) => ({ ...speaker, isPrimary: i === index })));
  }

  function removeSpeaker(index: number) {
    setSpeakers((current) => {
      const next = current.filter((_, i) => i !== index);
      return next.some((speaker) => speaker.isPrimary) || next.length === 0
        ? next
        : next.map((speaker, i) => ({ ...speaker, isPrimary: i === 0 }));
    });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const trimmedDuration = durationMinutes.trim();
    const parsedDuration = trimmedDuration === "" ? null : Number(trimmedDuration);
    if (parsedDuration !== null && !Number.isFinite(parsedDuration)) {
      setFieldErrors({ durationMinutes: ["Enter the length in minutes, numbers only."] });
      setSaveError(submissionErrorMessage("VALIDATION_ERROR"));
      return;
    }
    setBusyAction("save");
    setSaved(false);
    setSaveError(null);
    setFieldErrors({});
    try {
      const res = await fetch(`/api/cfp/submissions/${abstractId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          abstract: abstract.trim() === "" ? null : abstract,
          format: format.trim() === "" ? null : format,
          durationMinutes: parsedDuration,
          categoryId: categoryId === "" ? null : categoryId,
          // Only the questions currently on screen are sent; the backend merges
          // by key, so untouched answers stay exactly as they were.
          answers: Object.fromEntries(visibleFields.map((field) => [field.key, answers[field.key] ?? null])),
          // Omitted entirely when the roster is locked, so a converted talk's
          // confirmed line-up can never be touched from here (409 SPEAKERS_LOCKED).
          ...(rosterEditable ? { speakers } : {}),
        }),
      });
      const body = await res.json();
      if (!body?.ok) {
        setFieldErrors(body?.error?.fieldErrors ?? {});
        setSaveError(submissionErrorMessage(body?.error?.code ?? "UNKNOWN", body?.error?.message));
        return;
      }
      hydrate(body.data as Loaded);
      setSaved(true);
    } catch (error) {
      console.warn("Submission save failed", error);
      setSaveError(submissionErrorMessage("NETWORK_ERROR"));
    } finally {
      setBusyAction(null);
    }
  }

  async function withdraw() {
    // This merely hides an impossible control. The PATCH route remains
    // authoritative and re-checks status/session ownership under its lock.
    if (!canWithdraw) return;
    const confirmed = window.confirm(
      "Withdraw this proposal? It will be removed from consideration and you will not be able to undo it in the portal.",
    );
    if (!confirmed) return;

    setBusyAction("withdraw");
    setSaved(false);
    setWithdrawn(false);
    setSaveError(null);
    setFieldErrors({});
    try {
      const res = await fetch(`/api/cfp/submissions/${abstractId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "WITHDRAWN" }),
      });
      const body = await res.json();
      if (!body?.ok) {
        setSaveError(submissionErrorMessage(body?.error?.code ?? "UNKNOWN", body?.error?.message));
        return;
      }
      hydrate(body.data as Loaded);
      setWithdrawn(true);
    } catch (error) {
      console.warn("Submission withdrawal failed", error);
      setSaveError(submissionErrorMessage("NETWORK_ERROR"));
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <form className={styles.card} onSubmit={save}>
      <div className={styles.cardHead}>
        <div>
          <h2>{readOnly ? "Your proposal" : "Edit your proposal"}</h2>
          <p>
            {form.name} · <span className={`pill ${view.tone}`}>{view.label}</span>
          </p>
          <p className={styles.sessionMeta}>{view.detail}</p>
          {/* Honest about what an edit actually changes once a talk is scheduled. */}
          <p className={styles.sessionMeta}>{editScopeNotice(submission.speakersLocked)}</p>
        </div>
      </div>

      {readOnly ? (
        <p className={styles.saveNote} role="status">
          <Lock size={14} aria-hidden="true" /> {submission.lockReason ?? view.detail}
        </p>
      ) : null}

      {withdrawUnavailable ? <p className={styles.withdrawNotice}>{withdrawUnavailable}</p> : null}
      {canWithdraw ? (
        <p className={styles.withdrawHelp} id="withdraw-help">
          This removes the proposal from consideration. You cannot undo it in the portal.
        </p>
      ) : null}

      <div className={styles.field}>
        <label className="field-label" htmlFor="sub-title">Talk title</label>
        <input
          className="text-input" id="sub-title" value={title} disabled={readOnly}
          onChange={(e) => setTitle(e.target.value)}
          aria-invalid={!!fieldErrors.title}
        />
        {fieldErrors.title ? <p className={styles.saveError}>{fieldErrors.title.join(" ")}</p> : null}
      </div>

      <div className={styles.field}>
        <label className="field-label" htmlFor="sub-abstract">Description</label>
        <p className="hint">This is the description on your proposal record.</p>
        <textarea
          className="text-input" id="sub-abstract" value={abstract} disabled={readOnly}
          onChange={(e) => setAbstract(e.target.value)}
          aria-invalid={!!fieldErrors.abstract}
        />
        {fieldErrors.abstract ? <p className={styles.saveError}>{fieldErrors.abstract.join(" ")}</p> : null}
      </div>

      <div className={styles.field}>
        <label className="field-label" htmlFor="sub-format">Session type</label>
        <input className="text-input" id="sub-format" value={format} disabled={readOnly} onChange={(e) => setFormat(e.target.value)} />
      </div>

      <div className={styles.field}>
        <label className="field-label" htmlFor="sub-duration">Length in minutes</label>
        <input
          className="text-input" id="sub-duration" type="number" min={5} max={480} value={durationMinutes}
          disabled={readOnly} onChange={(e) => setDurationMinutes(e.target.value)}
          aria-invalid={!!fieldErrors.durationMinutes}
        />
        {fieldErrors.durationMinutes ? <p className={styles.saveError}>{fieldErrors.durationMinutes.join(" ")}</p> : null}
      </div>

      {form.categories.length > 0 ? (
        <div className={styles.field}>
          <label className="field-label" htmlFor="sub-category">Track</label>
          <select className="text-input" id="sub-category" value={categoryId} disabled={readOnly} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">No track</option>
            {form.categories.map((category) => (
              <option key={category.id} value={category.id}>{category.name}</option>
            ))}
          </select>
        </div>
      ) : null}

      {visibleFields.map((field) => (
        <FieldControl
          key={field.id}
          field={field}
          value={answers[field.key] as AnswerValue}
          onChange={(value) => setAnswers((current) => ({ ...current, [field.key]: value }))}
          error={fieldErrors[field.key]?.join(" ") ?? null}
          idPrefix="sub"
        />
      ))}

      <div className={styles.field}>
        <span className="field-label">Speakers</span>
        {rosterEditable ? (
          <>
            <p className="hint">
              Everyone listed here can edit this proposal. The main contact is who we reply to.
              Names for existing people come from their profiles; enter a name when adding a new email.
            </p>
            {speakers.map((speaker, index) => (
              <div className={styles.sessionItem} key={index}>
                <div className={styles.field}>
                  <label className="field-label" htmlFor={`speaker-name-${index}`}>Name</label>
                  <input
                    className="text-input" id={`speaker-name-${index}`} value={speaker.name}
                    readOnly={submission.speakers.some(
                      (existing) => existing.email.toLowerCase() === speaker.email.trim().toLowerCase(),
                    )}
                    required
                    onChange={(e) => updateSpeaker(index, { name: e.target.value })}
                  />
                </div>
                <div className={styles.field}>
                  <label className="field-label" htmlFor={`speaker-email-${index}`}>Email</label>
                  <input
                    className="text-input" id={`speaker-email-${index}`} type="email" value={speaker.email}
                    required
                    onChange={(e) => updateSpeaker(index, { email: e.target.value })}
                  />
                </div>
                <div className="row wrap">
                  <label className={styles.sessionMeta}>
                    <input
                      type="radio" name="primary-speaker" checked={speaker.isPrimary}
                      onChange={() => makePrimary(index)}
                    />{" "}
                    Main contact
                  </label>
                  {speakers.length > 1 ? (
                    <button
                      className="icon-button" type="button" onClick={() => removeSpeaker(index)}
                      aria-label={`Remove ${speaker.name || "this speaker"}`}
                    >
                      <X size={15} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
            {speakers.length < (form.maxSpeakers ?? 1) ? (
              <button
                className="ghost-button" type="button"
                onClick={() => setSpeakers((current) => [...current, { name: "", email: "", isPrimary: current.length === 0 }])}
              >
                <Plus size={15} aria-hidden="true" /> Add a co-speaker
              </button>
            ) : (
              <p className="hint">This form allows up to {form.maxSpeakers} speakers.</p>
            )}
            {fieldErrors.speakers ? <p className={styles.saveError}>{fieldErrors.speakers.join(" ")}</p> : null}
          </>
        ) : (
          <>
            <ul className={styles.taskList}>
              {submission.speakers.map((speaker) => (
                <li className={styles.sessionItem} key={speaker.email}>
                  <div className={styles.sessionTitle}>{speaker.name}{speaker.isPrimary ? " · main contact" : ""}</div>
                  <p className={styles.sessionMeta}>{speaker.email}</p>
                </li>
              ))}
            </ul>
            <p className="hint">
              {submission.speakersLocked
                ? "Your talk is on the programme, so the line-up is fixed here. Contact the programme team to change who's presenting."
                : "This proposal can no longer be edited."}
            </p>
          </>
        )}
      </div>

      {saveError ? <p className={styles.saveError} role="alert">{saveError}</p> : null}
      {saved ? <p className={styles.saveNote} role="status"><Check size={14} aria-hidden="true" /> {editSavedNotice(submission.speakersLocked)}</p> : null}
      {withdrawn ? <p className={styles.saveNote} role="status"><Check size={14} aria-hidden="true" /> {withdrawalSuccessNotice()}</p> : null}

      <div className={styles.formActions}>
        <Link className="ghost-button" href="/portal"><ArrowLeft size={15} aria-hidden="true" /> Back to your portal</Link>
        {canWithdraw ? (
          <button
            aria-describedby="withdraw-help"
            className={styles.withdrawButton}
            type="button"
            onClick={withdraw}
            disabled={busyAction !== null}
          >
            {submissionActionLabel("withdraw", busyAction)}
          </button>
        ) : null}
        {readOnly ? null : (
          <button className="primary-button" type="submit" disabled={busyAction !== null}>
            {submissionActionLabel("save", busyAction)}
          </button>
        )}
      </div>
    </form>
  );
}
