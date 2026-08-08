"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Lock } from "lucide-react";
import { FieldControl, type RenderField } from "@/components/field-renderer";
import { isFieldVisible, type AnswerMap, type AnswerValue } from "@/lib/form-logic";
import { submissionErrorMessage, submissionStatusView } from "@/lib/portal/submission-status";
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
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  function hydrate(data: Loaded) {
    setLoaded(data);
    setTitle(data.submission.title ?? "");
    setAbstract(data.submission.abstract ?? "");
    setFormat(data.submission.format ?? "");
    setDurationMinutes(data.submission.durationMinutes ? String(data.submission.durationMinutes) : "");
    setCategoryId(data.submission.categoryId ?? "");
    setAnswers({ ...data.answersByKey });
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
    () => (loaded?.form.fields ?? []).filter((field) => isFieldVisible(field as never, answers)),
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

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const trimmedDuration = durationMinutes.trim();
    const parsedDuration = trimmedDuration === "" ? null : Number(trimmedDuration);
    if (parsedDuration !== null && !Number.isFinite(parsedDuration)) {
      setFieldErrors({ durationMinutes: ["Enter the length in minutes, numbers only."] });
      setSaveError(submissionErrorMessage("VALIDATION_ERROR"));
      return;
    }
    setSaving(true);
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
      setSaving(false);
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
        </div>
      </div>

      {readOnly ? (
        <p className={styles.saveNote} role="status">
          <Lock size={14} aria-hidden="true" /> {submission.lockReason ?? view.detail}
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
        <p className="hint">This is what attendees read in the program.</p>
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
        <ul className={styles.taskList}>
          {submission.speakers.map((speaker) => (
            <li className={styles.sessionItem} key={speaker.email}>
              <div className={styles.sessionTitle}>{speaker.name}{speaker.isPrimary ? " · main contact" : ""}</div>
              <p className={styles.sessionMeta}>{speaker.email}</p>
            </li>
          ))}
        </ul>
        {submission.speakersLocked ? (
          <p className="hint">
            Your talk is on the program, so the speaker list is fixed here. Contact the program team to change who&apos;s presenting.
          </p>
        ) : (
          <p className="hint">Contact the program team to add or remove a speaker.</p>
        )}
      </div>

      {saveError ? <p className={styles.saveError} role="alert">{saveError}</p> : null}
      {saved ? <p className={styles.saveNote} role="status"><Check size={14} aria-hidden="true" /> Saved. The program team sees your changes right away.</p> : null}

      <div className={styles.formActions}>
        <Link className="ghost-button" href="/portal"><ArrowLeft size={15} aria-hidden="true" /> Back to your portal</Link>
        {readOnly ? null : (
          <button className="primary-button" type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        )}
      </div>
    </form>
  );
}
