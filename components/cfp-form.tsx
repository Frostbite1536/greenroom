"use client";

import { Fragment, useMemo, useState } from "react";
import { Check, Megaphone, Plus, Trash2 } from "lucide-react";
import type { FormModel } from "@/lib/fixtures";
import { FieldControl } from "@/components/field-renderer";
import { isFieldVisible, validateField, type AnswerMap } from "@/lib/form-logic";

type Speaker = { name: string; email: string; isPrimary: boolean };
type Step = 0 | 1 | 2 | 3;
const STEP_LABELS = ["Welcome", "Submission", "Participants", "Review"];

export function CfpForm({ form }: { form: FormModel }) {
  const [step, setStep] = useState<Step>(0);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [speakers, setSpeakers] = useState<Speaker[]>([{ name: "", email: "", isPrimary: true }]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);

  const visibleFields = useMemo(() => form.fields.filter((f) => isFieldVisible(f, answers)), [form.fields, answers]);

  function setAnswer(key: string, v: AnswerMap[string]) {
    setAnswers((a) => ({ ...a, [key]: v }));
    setErrors((e) => {
      const next = { ...e };
      delete next[key];
      return next;
    });
    setDraftSaved(false);
  }

  function validateSubmission(): boolean {
    const next: Record<string, string> = {};
    for (const field of visibleFields) {
      const err = validateField(field, answers[field.key]);
      if (err) next[field.key] = err;
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function validateParticipants(): boolean {
    const next: Record<string, string> = {};
    if (speakers.length < form.minSpeakers) next.__speakers = `At least ${form.minSpeakers} speaker(s) required.`;
    if (speakers.length > form.maxSpeakers) next.__speakers = `No more than ${form.maxSpeakers} speaker(s) allowed.`;
    speakers.forEach((s, i) => {
      if (!s.name.trim()) next[`sp_name_${i}`] = "Name required.";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.email)) next[`sp_email_${i}`] = "Valid email required.";
    });
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function next() {
    if (step === 1 && !validateSubmission()) return;
    if (step === 2 && !validateParticipants()) return;
    setStep((s) => Math.min(3, s + 1) as Step);
  }

  function submit() {
    if (!validateSubmission()) {
      setStep(1);
      return;
    }
    if (!validateParticipants()) {
      setStep(2);
      return;
    }
    // Contract shape matches abstractUpsertSchema (intent: "submit").
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <div className="cfp-card">
        <div className="cfp-success">
          <div className="check"><Check size={28} aria-hidden="true" /></div>
          <h2 style={{ margin: 0 }}>Submission received</h2>
          <p className="muted" style={{ maxWidth: 460, margin: "0 auto" }}>{form.thankYouText}</p>
          <div className="row" style={{ justifyContent: "center", marginTop: 8 }}>
            <a className="primary-button" href="/portal">Go to speaker portal</a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="cfp-card">
      {/* stepper */}
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

      {step === 0 && (
        <div>
          {(form.closesAt || form.submissionLimit) && (
            <div className="cfp-notice">
              {form.closesAt && (
                <div>Submissions accepted until {new Date(form.closesAt).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}</div>
              )}
              {form.submissionLimit && <div>Submission limit: {form.submissionLimit} per user</div>}
            </div>
          )}
          <h2 style={{ marginTop: 0 }}>{form.welcomeHeading}</h2>
          <p style={{ lineHeight: 1.6, color: "var(--ink)", whiteSpace: "pre-line" }}>{form.welcomeText}</p>
        </div>
      )}

      {step === 1 && (
        <div>
          <h2 style={{ marginTop: 0 }}>Tell us about your submission</h2>
          <p className="hint" style={{ marginBottom: 18 }}>What do you want to present? Fill out the following.</p>
          {visibleFields.map((field) => (
            <FieldControl
              key={field.id}
              idPrefix="cfp"
              field={field}
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
            Add {form.minSpeakers === form.maxSpeakers ? form.minSpeakers : `${form.minSpeakers}–${form.maxSpeakers}`} speaker(s). Co-speakers get their own portal access by email.
          </p>
          {errors.__speakers ? <p className="field-error" style={{ marginBottom: 10 }}>{errors.__speakers}</p> : null}
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
              <button
                type="button"
                className="ghost-button danger-button"
                aria-label="Remove speaker"
                disabled={speakers.length <= 1 || i === 0}
                onClick={() => setSpeakers((s) => s.filter((_, j) => j !== i))}
              >
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
            {visibleFields.map((field) => (
              <div className="kv" key={field.id}>
                <span>{field.label}</span>
                <span>{formatValue(answers[field.key])}</span>
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
        {step >= 1 && step <= 2 && (
          <button className="ghost-button" type="button" onClick={() => setDraftSaved(true)}>
            {draftSaved ? "Draft saved" : "Save draft"}
          </button>
        )}
        {step < 3 ? (
          <button className="primary-button" type="button" onClick={next}>Next</button>
        ) : (
          <button className="primary-button" type="button" onClick={submit}>Submit proposal</button>
        )}
      </div>
    </div>
  );
}

function formatValue(v: AnswerMap[string]): string {
  if (v === undefined || v === null || v === "") return "—";
  if (v === true) return "Yes";
  if (v === false) return "No";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

export function CfpBrand({ eventName }: { eventName: string }) {
  return (
    <div className="cfp-brand">
      <span className="brand-mark"><Megaphone size={17} aria-hidden="true" /></span>
      <span>{eventName}</span>
    </div>
  );
}
