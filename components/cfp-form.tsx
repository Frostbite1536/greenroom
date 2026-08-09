"use client";

import { Fragment, useMemo, useState } from "react";
import { Check, Megaphone, Plus, Trash2 } from "lucide-react";
import type { PublicFormView } from "@/lib/data/reads";
import { FieldControl } from "@/components/field-renderer";
import { resolveVisibleFields, validateField, type AnswerMap, type AnswerValue } from "@/lib/form-logic";
import { apiPost, firstFieldErrors } from "@/lib/api-client";

type Speaker = { name: string; email: string; isPrimary: boolean };
type Step = 0 | 1 | 2 | 3;
const STEP_LABELS = ["Welcome", "Submission", "Participants", "Review"];

/** Session formats offered to submitters, with the duration each implies. */
const FORMATS: { label: string; value: string; minutes: number }[] = [
  { label: "Lightning talk (10 min)", value: "Lightning Talk", minutes: 10 },
  { label: "Talk (30 min)", value: "Talk", minutes: 30 },
  { label: "Deep dive (45 min)", value: "Deep Dive", minutes: 45 },
  { label: "Workshop (90 min)", value: "Workshop", minutes: 90 },
];

type SubmissionResult = { id: string; status: string };

export function CfpForm({ form }: { form: PublicFormView }) {
  const [step, setStep] = useState<Step>(0);
  const [title, setTitle] = useState("");
  const [abstract, setAbstract] = useState("");
  const [format, setFormat] = useState(FORMATS[1].value);
  const [categoryId, setCategoryId] = useState("");
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [speakers, setSpeakers] = useState<Speaker[]>([{ name: "", email: "", isPrimary: true }]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "draft" | "submit">(null);

  const visibleFields = useMemo(
    () => resolveVisibleFields(form.fields, answers),
    [form.fields, answers],
  );

  function setAnswer(key: string, v: AnswerValue) {
    setAnswers((a) => ({ ...a, [key]: v }));
    setErrors((e) => {
      const next = { ...e };
      delete next[key];
      return next;
    });
    setDraftSavedAt(null);
  }

  function buildPayload(intent: "saveDraft" | "submit") {
    const chosen = FORMATS.find((f) => f.value === format);
    return {
      formConfigId: form.id,
      abstractId: draftId ?? undefined,
      title: title.trim(),
      abstract: abstract.trim() || undefined,
      format: chosen?.value,
      durationMinutes: chosen?.minutes,
      categoryId: categoryId || undefined,
      speakers: speakers.map((s) => ({
        email: s.email.trim().toLowerCase(),
        name: s.name.trim(),
        isPrimary: s.isPrimary,
      })),
      answers: Object.fromEntries(visibleFields.map((f) => [f.key, answers[f.key] ?? null])),
      intent,
    };
  }

  function validateSubmissionStep(): boolean {
    const next: Record<string, string> = {};
    if (title.trim().length < 3) next.title = "Give your session a title (at least 3 characters).";
    for (const field of visibleFields) {
      const err = validateField(field, answers[field.key]);
      if (err) next[field.key] = err;
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function validateParticipants(): boolean {
    const next: Record<string, string> = {};
    if (speakers.length < form.minSpeakers) next.speakers = `At least ${form.minSpeakers} speaker(s) required.`;
    if (speakers.length > form.maxSpeakers) next.speakers = `No more than ${form.maxSpeakers} speaker(s) allowed.`;
    speakers.forEach((s, i) => {
      if (!s.name.trim()) next[`sp_name_${i}`] = "Name required.";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.email)) next[`sp_email_${i}`] = "Valid email required.";
    });
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function next() {
    setFormError(null);
    if (step === 1 && !validateSubmissionStep()) return;
    if (step === 2 && !validateParticipants()) return;
    setStep((s) => Math.min(3, s + 1) as Step);
  }

  /** Drafts skip window/required checks server-side, so only the title is needed. */
  async function saveDraft() {
    setFormError(null);
    if (title.trim().length < 3) {
      setErrors({ title: "Add a title before saving a draft." });
      setStep(1);
      return;
    }
    if (!speakers[0]?.email.trim() || !speakers[0]?.name.trim()) {
      setErrors({ sp_email_0: "Add your name and email to save a draft.", sp_name_0: "Required." });
      setStep(2);
      return;
    }
    setBusy("draft");
    const res = await apiPost<SubmissionResult>("/api/cfp/submissions", buildPayload("saveDraft"));
    setBusy(null);
    if (!res.ok) {
      setFormError(res.error.message);
      setErrors(firstFieldErrors(res.error.fieldErrors));
      return;
    }
    setDraftId(res.data.id);
    setDraftSavedAt(new Date().toLocaleTimeString());
  }

  async function submit() {
    setFormError(null);
    if (!validateSubmissionStep()) {
      setStep(1);
      return;
    }
    if (!validateParticipants()) {
      setStep(2);
      return;
    }
    setBusy("submit");
    const res = await apiPost<SubmissionResult>("/api/cfp/submissions", buildPayload("submit"));
    setBusy(null);
    if (!res.ok) {
      setFormError(res.error.message);
      const mapped = firstFieldErrors(res.error.fieldErrors);
      setErrors(mapped);
      // Send the submitter back to the step that owns the failure.
      if (mapped.speakers || Object.keys(mapped).some((k) => k.startsWith("speakers"))) setStep(2);
      else if (Object.keys(mapped).length > 0) setStep(1);
      return;
    }
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <div className="cfp-card">
        <div className="cfp-success">
          <div className="check"><Check size={28} aria-hidden="true" /></div>
          <h2 style={{ margin: 0 }}>Submission received</h2>
          <p className="muted" style={{ maxWidth: 460, margin: "0 auto" }}>
            {form.thankYouText ?? "Thanks for your submission! The program team will follow up by email."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="cfp-card">
      <div className="cfp-steps">
        {STEP_LABELS.map((label, i) => (
          <Fragment key={label}>
            {i > 0 ? <span className="sep" aria-hidden="true">→</span> : null}
            <span className={`cfp-step ${step === i ? "active" : ""} ${step > i ? "done" : ""}`}>
              <span className="n">{step > i ? <Check size={13} /> : i + 1}</span>
              {label}
            </span>
          </Fragment>
        ))}
      </div>

      {formError ? <div className="conflict-banner" style={{ marginBottom: 16 }} role="alert">{formError}</div> : null}

      {step === 0 && (
        <div>
          {(form.closesAt || form.minSpeakers > 1) && (
            <div className="cfp-notice">
              {form.closesAt && (
                <div>
                  Submissions accepted until{" "}
                  {new Date(form.closesAt).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}
                </div>
              )}
              <div>
                {form.minSpeakers === form.maxSpeakers
                  ? `${form.minSpeakers} speaker(s) per submission`
                  : `${form.minSpeakers}–${form.maxSpeakers} speakers per submission`}
              </div>
            </div>
          )}
          <h2 style={{ marginTop: 0 }}>{form.name}</h2>
          {form.welcomeText ? (
            <p style={{ lineHeight: 1.6, color: "var(--ink)", whiteSpace: "pre-line" }}>{form.welcomeText}</p>
          ) : (
            <p className="muted">Share your proposal below. You can save a draft and finish later.</p>
          )}
        </div>
      )}

      {step === 1 && (
        <div>
          <h2 style={{ marginTop: 0 }}>Tell us about your submission</h2>
          <p className="hint" style={{ marginBottom: 18 }}>What do you want to present?</p>

          <div className="cfp-field">
            <label className="field-label" htmlFor="cfp-title">
              Session title <span className="req" aria-hidden="true">*</span>
            </label>
            <input
              id="cfp-title"
              className="text-input"
              value={title}
              aria-invalid={!!errors.title}
              aria-describedby={errors.title ? "cfp-title-err" : undefined}
              onChange={(e) => {
                setTitle(e.target.value);
                setErrors((x) => ({ ...x, title: "" }));
              }}
            />
            {errors.title ? <p className="field-error" id="cfp-title-err">{errors.title}</p> : null}
          </div>

          <div className="cfp-field">
            <label className="field-label" htmlFor="cfp-abstract">Abstract</label>
            <p className="hint" id="cfp-abstract-help">What will attendees learn? 150–300 words works well.</p>
            <textarea id="cfp-abstract" className="text-input" rows={6} value={abstract} aria-describedby="cfp-abstract-help" onChange={(e) => setAbstract(e.target.value)} />
          </div>

          <div className="cfp-field">
            <label className="field-label" htmlFor="cfp-format">Session format</label>
            <select id="cfp-format" className="select-input" value={format} onChange={(e) => setFormat(e.target.value)}>
              {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>

          {form.categories.length > 0 && (
            <div className="cfp-field">
              <label className="field-label" htmlFor="cfp-category">Topic category</label>
              <p className="hint" id="cfp-category-help">Routes your proposal to the right review team.</p>
              <select id="cfp-category" className="select-input" value={categoryId} aria-describedby="cfp-category-help" onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">Select…</option>
                {form.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}

          {visibleFields.map((field) => (
            <FieldControl
              key={field.id}
              idPrefix="cfp"
              field={{
                id: field.id,
                key: field.key,
                label: field.label,
                helpText: field.helpText ?? undefined,
                type: field.type,
                required: field.required,
                options: field.options ?? undefined,
                conditionalLogic: field.conditionalLogic ?? undefined,
              }}
              value={answers[field.key]}
              error={errors[field.key]}
              onChange={(v) => setAnswer(field.key, v)}
            />
          ))}
        </div>
      )}

      {step === 2 && (
        <div>
          <h2 style={{ marginTop: 0 }}>Participants</h2>
          <p className="hint" style={{ marginBottom: 18 }}>
            Add {form.minSpeakers === form.maxSpeakers ? form.minSpeakers : `${form.minSpeakers}–${form.maxSpeakers}`} speaker(s).
            Co-speakers will be contacted by email.
          </p>
          {errors.speakers ? <p className="field-error" style={{ marginBottom: 10 }} role="alert">{errors.speakers}</p> : null}
          {speakers.map((sp, i) => (
            <div className="speaker-row" key={i}>
              <label className="stack">
                <span className="field-label">Full name {i === 0 ? "(primary)" : ""}</span>
                <input className="text-input" value={sp.name} aria-invalid={!!errors[`sp_name_${i}`]} onChange={(e) => setSpeakers((s) => s.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                {errors[`sp_name_${i}`] ? <span className="field-error">{errors[`sp_name_${i}`]}</span> : null}
              </label>
              <label className="stack">
                <span className="field-label">Email</span>
                <input className="text-input" type="email" value={sp.email} aria-invalid={!!errors[`sp_email_${i}`]} onChange={(e) => setSpeakers((s) => s.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} />
                {errors[`sp_email_${i}`] ? <span className="field-error">{errors[`sp_email_${i}`]}</span> : null}
              </label>
              <button type="button" className="ghost-button danger-button" aria-label="Remove speaker" disabled={i === 0} onClick={() => setSpeakers((s) => s.filter((_, j) => j !== i))}>
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          {speakers.length < form.maxSpeakers && (
            <button className="ghost-button" type="button" onClick={() => setSpeakers((s) => [...s, { name: "", email: "", isPrimary: false }])}>
              <Plus size={15} /> Add co-speaker
            </button>
          )}
        </div>
      )}

      {step === 3 && (
        <div>
          <h2 style={{ marginTop: 0 }}>Review &amp; submit</h2>
          <div className="detail-drawer" style={{ marginTop: 12 }}>
            <div className="kv"><span>Title</span><span>{title || "—"}</span></div>
            <div className="kv"><span>Abstract</span><span>{abstract || "—"}</span></div>
            <div className="kv"><span>Format</span><span>{FORMATS.find((f) => f.value === format)?.label ?? "—"}</span></div>
            {form.categories.length > 0 && (
              <div className="kv">
                <span>Category</span>
                <span>{form.categories.find((c) => c.id === categoryId)?.name ?? "—"}</span>
              </div>
            )}
            {visibleFields.map((field) => (
              <div className="kv" key={field.id}>
                <span>{field.label}</span>
                <span>{formatValue(answers[field.key], field.options ?? null)}</span>
              </div>
            ))}
            <div className="kv">
              <span>Speakers</span>
              <span>{speakers.map((s) => `${s.name} (${s.email})`).join(", ")}</span>
            </div>
          </div>
        </div>
      )}

      <div className="cfp-actions">
        {step > 0 && (
          <button className="ghost-button" type="button" onClick={() => setStep((s) => Math.max(0, s - 1) as Step)}>Back</button>
        )}
        <span className="spacer" />
        {step >= 1 && (
          <button className="ghost-button" type="button" onClick={saveDraft} disabled={busy !== null}>
            {busy === "draft" ? "Saving…" : draftSavedAt ? `Draft saved ${draftSavedAt}` : "Save draft"}
          </button>
        )}
        {step < 3 ? (
          <button className="primary-button" type="button" onClick={next}>Next</button>
        ) : (
          <button className="primary-button" type="button" onClick={submit} disabled={busy !== null}>
            {busy === "submit" ? "Submitting…" : "Submit proposal"}
          </button>
        )}
      </div>
    </div>
  );
}

function formatValue(v: AnswerValue, options: { label: string; value: string }[] | null): string {
  if (v === undefined || v === null || v === "") return "—";
  if (v === true) return "Yes";
  if (v === false) return "No";
  if (Array.isArray(v)) {
    return v.map((x) => options?.find((o) => o.value === x)?.label ?? x).join(", ");
  }
  return options?.find((o) => o.value === v)?.label ?? String(v);
}

export function CfpBrand({ eventName }: { eventName: string }) {
  return (
    <div className="cfp-brand">
      <span className="brand-mark"><Megaphone size={17} aria-hidden="true" /></span>
      <span>{eventName}</span>
    </div>
  );
}
