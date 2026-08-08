"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  ExternalLink,
  GripVertical,
  ListChecks,
  Plus,
  Save,
  Settings2,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { FieldType, FormFieldModel, FormModel } from "@/lib/fixtures";
import { FieldControl } from "@/components/field-renderer";
import { isFieldVisible, type AnswerMap } from "@/lib/form-logic";
import { Switch } from "@/components/ui";

type Step = "welcome" | "fields" | "settings";

const STEPS: { key: Step; title: string; sub: string; icon: typeof Sparkles }[] = [
  { key: "welcome", title: "Welcome screen", sub: "Message and intro copy", icon: Sparkles },
  { key: "fields", title: "Form questions", sub: "Fields and conditional logic", icon: ListChecks },
  { key: "settings", title: "Form settings", sub: "Deadlines, limits, speakers", icon: Settings2 },
];

const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: "SHORT_TEXT", label: "Short text" },
  { value: "LONG_TEXT", label: "Long text" },
  { value: "NUMBER", label: "Number" },
  { value: "SELECT", label: "Dropdown" },
  { value: "MULTI_SELECT", label: "Multi-select" },
  { value: "CHECKBOX", label: "Checkbox" },
  { value: "URL", label: "URL" },
];

const HAS_OPTIONS: FieldType[] = ["SELECT", "MULTI_SELECT"];

let uid = 0;
const newKey = () => `field_${Date.now()}_${uid++}`;

export function FormBuilder({ form: initial }: { form: FormModel }) {
  const [form, setForm] = useState<FormModel>(initial);
  const [step, setStep] = useState<Step>("fields");
  const [openField, setOpenField] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function patch(p: Partial<FormModel>) {
    setForm((f) => ({ ...f, ...p }));
    setSaved(false);
  }
  function patchField(id: string, p: Partial<FormFieldModel>) {
    setForm((f) => ({ ...f, fields: f.fields.map((fl) => (fl.id === id ? { ...fl, ...p } : fl)) }));
    setSaved(false);
  }
  function addField() {
    const id = newKey();
    const field: FormFieldModel = { id, key: `question_${form.fields.length + 1}`, label: "New question", type: "SHORT_TEXT", required: false };
    setForm((f) => ({ ...f, fields: [...f.fields, field] }));
    setOpenField(id);
    setStep("fields");
    setSaved(false);
  }
  function removeField(id: string) {
    setForm((f) => ({ ...f, fields: f.fields.filter((fl) => fl.id !== id) }));
    setSaved(false);
  }
  function move(id: string, dir: -1 | 1) {
    setForm((f) => {
      const idx = f.fields.findIndex((fl) => fl.id === id);
      const j = idx + dir;
      if (idx < 0 || j < 0 || j >= f.fields.length) return f;
      const fields = [...f.fields];
      [fields[idx], fields[j]] = [fields[j], fields[idx]];
      return { ...f, fields };
    });
    setSaved(false);
  }

  return (
    <div className="page-stack" style={{ width: "min(1280px, 100%)" }}>
      <div className="row wrap" style={{ justifyContent: "space-between" }}>
        <div>
          <Link href="/admin/forms" className="link-button row" style={{ gap: 6, marginBottom: 6 }}>
            <ArrowLeft size={14} /> Back to forms
          </Link>
          <h1 style={{ margin: 0, fontSize: 24 }}>Edit form</h1>
          <p className="hint">{form.name}</p>
        </div>
        <div className="row wrap">
          <Link className="ghost-button" href={`/cfp/${form.id}`} target="_blank">
            <ExternalLink size={15} /> View form
          </Link>
          <button className="ghost-button" type="button" onClick={() => navigator.clipboard?.writeText(`${location.origin}/cfp/${form.id}`)}>
            Copy link
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => setSaved(true)}
            style={{ display: "inline-flex", alignItems: "center", gap: 7 }}
          >
            {saved ? <Check size={16} /> : <Save size={16} />} {saved ? "Saved" : "Save"}
          </button>
        </div>
      </div>

      <div className="card builder">
        {/* left nav */}
        <nav className="builder-nav" aria-label="Form setup steps">
          <p className="nav-eyebrow">Form setup</p>
          {STEPS.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.key}
                type="button"
                className={`builder-step ${step === s.key ? "active" : ""}`}
                aria-current={step === s.key}
                onClick={() => setStep(s.key)}
              >
                <span className="step-dot"><Icon size={15} aria-hidden="true" /></span>
                <span>
                  <span className="step-title">{s.title}</span>
                  <br />
                  <span className="step-sub">{s.sub}</span>
                </span>
              </button>
            );
          })}
        </nav>

        {/* center panel */}
        <div className="builder-panel">
          {step === "welcome" && <WelcomeStep form={form} patch={patch} />}
          {step === "fields" && (
            <FieldsStep
              form={form}
              openField={openField}
              setOpenField={setOpenField}
              patchField={patchField}
              addField={addField}
              removeField={removeField}
              move={move}
            />
          )}
          {step === "settings" && <SettingsStep form={form} patch={patch} />}
        </div>

        {/* right preview */}
        <aside className="builder-preview" aria-label="Live preview">
          <p className="preview-eyebrow">Live preview</p>
          <Preview form={form} />
        </aside>
      </div>
    </div>
  );
}

function WelcomeStep({ form, patch }: { form: FormModel; patch: (p: Partial<FormModel>) => void }) {
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div><h2>Welcome screen</h2><p className="hint">The first screen a submitter sees.</p></div>
      <div className="grid-2">
        <label className="stack">
          <span className="field-label">Internal form name</span>
          <input className="text-input" value={form.name} onChange={(e) => patch({ name: e.target.value })} />
        </label>
        <label className="stack">
          <span className="field-label">External form title</span>
          <input className="text-input" value={form.externalTitle} onChange={(e) => patch({ externalTitle: e.target.value })} />
        </label>
      </div>
      <label className="stack">
        <span className="field-label">Page heading</span>
        <input className="text-input" value={form.welcomeHeading} onChange={(e) => patch({ welcomeHeading: e.target.value })} />
      </label>
      <label className="stack">
        <span className="field-label">Welcome message</span>
        <textarea className="text-input" rows={6} value={form.welcomeText} onChange={(e) => patch({ welcomeText: e.target.value })} />
      </label>
      <label className="stack">
        <span className="field-label">Thank-you message</span>
        <textarea className="text-input" rows={3} value={form.thankYouText} onChange={(e) => patch({ thankYouText: e.target.value })} />
      </label>
    </div>
  );
}

function FieldsStep({
  form,
  openField,
  setOpenField,
  patchField,
  addField,
  removeField,
  move,
}: {
  form: FormModel;
  openField: string | null;
  setOpenField: (id: string | null) => void;
  patchField: (id: string, p: Partial<FormFieldModel>) => void;
  addField: () => void;
  removeField: (id: string) => void;
  move: (id: string, dir: -1 | 1) => void;
}) {
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div><h2>Form questions</h2><p className="hint">Collect information about submitted abstracts.</p></div>
        <button className="ghost-button" type="button" onClick={addField}><Plus size={15} /> Add field</button>
      </div>

      {form.fields.map((field, i) => {
        const open = openField === field.id;
        return (
          <div className="field-editor" key={field.id}>
            <div className="field-editor-head">
              <span className="drag" aria-hidden="true"><GripVertical size={16} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setOpenField(open ? null : field.id)}
                  style={{ color: "var(--ink)", fontWeight: 600 }}
                >
                  {field.label || "Untitled question"}
                </button>
                <p className="hint">
                  {FIELD_TYPES.find((t) => t.value === field.type)?.label}
                  {field.required ? " · Required" : ""}
                  {field.conditionalLogic ? " · Conditional" : ""}
                  {field.locked ? " · Locked" : ""}
                </p>
              </div>
              <div className="row" style={{ gap: 4 }}>
                <button className="ghost-button" type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(field.id, -1)}>↑</button>
                <button className="ghost-button" type="button" aria-label="Move down" disabled={i === form.fields.length - 1} onClick={() => move(field.id, 1)}>↓</button>
                <span className="row" style={{ gap: 6 }}>
                  <Switch checked={field.required} onChange={(v) => patchField(field.id, { required: v })} label="Required" />
                  <span className="hint">Required</span>
                </span>
                {!field.locked && (
                  <button className="ghost-button danger-button" type="button" aria-label="Delete field" onClick={() => removeField(field.id)}>
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>

            {open && (
              <div className="field-editor-body">
                <div className="grid-2">
                  <label className="stack">
                    <span className="field-label">Label</span>
                    <input className="text-input" value={field.label} onChange={(e) => patchField(field.id, { label: e.target.value })} />
                  </label>
                  <label className="stack">
                    <span className="field-label">Field type</span>
                    <select className="select-input" value={field.type} disabled={field.locked} onChange={(e) => patchField(field.id, { type: e.target.value as FieldType })}>
                      {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </label>
                </div>
                <label className="stack">
                  <span className="field-label">Help text</span>
                  <input className="text-input" value={field.helpText ?? ""} onChange={(e) => patchField(field.id, { helpText: e.target.value })} />
                </label>

                {HAS_OPTIONS.includes(field.type) && (
                  <label className="stack">
                    <span className="field-label">Options (one per line)</span>
                    <textarea
                      className="text-input"
                      rows={3}
                      value={(field.options ?? []).map((o) => o.label).join("\n")}
                      onChange={(e) =>
                        patchField(field.id, {
                          options: e.target.value
                            .split("\n")
                            .map((s) => s.trim())
                            .filter(Boolean)
                            .map((label) => ({ label, value: label.toLowerCase().replace(/[^a-z0-9]+/g, "-") })),
                        })
                      }
                    />
                  </label>
                )}

                <LogicEditor form={form} field={field} patchField={patchField} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function LogicEditor({
  form,
  field,
  patchField,
}: {
  form: FormModel;
  field: FormFieldModel;
  patchField: (id: string, p: Partial<FormFieldModel>) => void;
}) {
  const logic = field.conditionalLogic;
  const others = form.fields.filter((f) => f.id !== field.id);

  if (!logic) {
    return (
      <button
        className="link-button"
        type="button"
        onClick={() =>
          patchField(field.id, { conditionalLogic: { match: "all", rules: [{ fieldKey: others[0]?.key ?? "", operator: "equals", value: "" }] } })
        }
      >
        + Add conditional logic (only show this field when…)
      </button>
    );
  }

  return (
    <div className="logic-box">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="field-label">Only show when…</span>
        <button className="link-button" type="button" onClick={() => patchField(field.id, { conditionalLogic: undefined })}>Remove</button>
      </div>
      {logic.rules.map((rule, ri) => (
        <div className="grid-2" key={ri}>
          <select
            className="select-input"
            value={rule.fieldKey}
            onChange={(e) => {
              const rules = logic.rules.map((r, i) => (i === ri ? { ...r, fieldKey: e.target.value } : r));
              patchField(field.id, { conditionalLogic: { ...logic, rules } });
            }}
          >
            {others.map((o) => <option key={o.id} value={o.key}>{o.label}</option>)}
          </select>
          <div className="row" style={{ gap: 8 }}>
            <select
              className="select-input"
              value={rule.operator}
              onChange={(e) => {
                const rules = logic.rules.map((r, i) => (i === ri ? { ...r, operator: e.target.value as typeof r.operator } : r));
                patchField(field.id, { conditionalLogic: { ...logic, rules } });
              }}
            >
              <option value="equals">equals</option>
              <option value="notEquals">does not equal</option>
              <option value="includes">includes</option>
              <option value="isNotEmpty">is answered</option>
              <option value="isEmpty">is empty</option>
            </select>
            {rule.operator !== "isEmpty" && rule.operator !== "isNotEmpty" && (
              <input
                className="text-input"
                placeholder="value"
                value={rule.value === undefined ? "" : String(rule.value)}
                onChange={(e) => {
                  const rules = logic.rules.map((r, i) => (i === ri ? { ...r, value: e.target.value } : r));
                  patchField(field.id, { conditionalLogic: { ...logic, rules } });
                }}
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function SettingsStep({ form, patch }: { form: FormModel; patch: (p: Partial<FormModel>) => void }) {
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div><h2>Form settings</h2><p className="hint">Deadlines, limits, and speaker constraints enforced on submit.</p></div>
      <div className="grid-2">
        <label className="stack">
          <span className="field-label">Opens at</span>
          <input type="date" className="text-input" value={form.opensAt?.slice(0, 10) ?? ""} onChange={(e) => patch({ opensAt: e.target.value ? `${e.target.value}T00:00:00.000Z` : undefined })} />
        </label>
        <label className="stack">
          <span className="field-label">Closes at</span>
          <input type="date" className="text-input" value={form.closesAt?.slice(0, 10) ?? ""} onChange={(e) => patch({ closesAt: e.target.value ? `${e.target.value}T23:59:00.000Z` : undefined })} />
        </label>
      </div>
      <div className="grid-2">
        <label className="stack">
          <span className="field-label">Submission limit per user</span>
          <input type="number" min={1} className="text-input" value={form.submissionLimit ?? ""} onChange={(e) => patch({ submissionLimit: e.target.value ? Number(e.target.value) : undefined })} />
        </label>
        <label className="stack">
          <span className="field-label">Max bio length</span>
          <input type="number" min={100} className="text-input" value={form.maxBioLength} onChange={(e) => patch({ maxBioLength: Number(e.target.value) })} />
        </label>
      </div>
      <div className="grid-2">
        <label className="stack">
          <span className="field-label">Min speakers</span>
          <input type="number" min={1} className="text-input" value={form.minSpeakers} onChange={(e) => patch({ minSpeakers: Number(e.target.value) })} />
        </label>
        <label className="stack">
          <span className="field-label">Max speakers</span>
          <input type="number" min={1} className="text-input" value={form.maxSpeakers} onChange={(e) => patch({ maxSpeakers: Number(e.target.value) })} />
        </label>
      </div>
      <div className="card" style={{ padding: 16 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div><span className="field-label">Published</span><p className="hint">Public submissions are accepted while published and within the window.</p></div>
          <Switch checked={form.published} onChange={(v) => patch({ published: v })} label="Published" />
        </div>
      </div>
    </div>
  );
}

function Preview({ form }: { form: FormModel }) {
  // Show fields with a sample answer state so conditional logic is visible.
  const [answers, setAnswers] = useState<AnswerMap>({});
  const visible = useMemo(() => form.fields.filter((f) => isFieldVisible(f, answers)), [form.fields, answers]);
  const hiddenCount = form.fields.length - visible.length;

  return (
    <div className="card" style={{ padding: 16, background: "white" }}>
      <p className="eyebrow">{form.externalTitle}</p>
      <h3 style={{ margin: "2px 0 8px" }}>{form.welcomeHeading}</h3>
      <p className="hint" style={{ marginBottom: 14 }}>{form.welcomeText.slice(0, 140)}{form.welcomeText.length > 140 ? "…" : ""}</p>
      {visible.map((field) => (
        <FieldControl
          key={field.id}
          idPrefix="preview"
          field={field}
          value={answers[field.key]}
          onChange={(v) => setAnswers((a) => ({ ...a, [field.key]: v }))}
        />
      ))}
      {hiddenCount > 0 ? <p className="hint">+ {hiddenCount} conditional field{hiddenCount > 1 ? "s" : ""} hidden by current answers</p> : null}
    </div>
  );
}
