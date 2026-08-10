"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
import type { BuilderForm, FieldView } from "@/lib/data/reads";
import { FieldControl } from "@/components/field-renderer";
import { resolveVisibleFields, type AnswerMap } from "@/lib/form-logic";
import { apiPost, firstFieldErrors } from "@/lib/api-client";
import { zonedParts, zonedToUtcIso } from "@/lib/tz";
import { Switch } from "@/components/ui";

type Step = "welcome" | "fields" | "settings";
type FieldType = FieldView["type"];

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
const KEY_RE = /^[a-z][a-z0-9_]*$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Local editing shape: `localId` keeps React keys stable; the API keys by `key`. */
type DraftField = Omit<FieldView, "id" | "sortOrder"> & { localId: string };

let seq = 0;
const nextLocalId = () => `local_${Date.now()}_${seq++}`;

function toDraft(form: BuilderForm) {
  return {
    name: form.name,
    slug: form.slug,
    welcomeText: form.welcomeText ?? "",
    thankYouText: form.thankYouText ?? "",
    opensAt: form.opensAt,
    closesAt: form.closesAt,
    submissionLimit: form.submissionLimit,
    minSpeakers: form.minSpeakers,
    maxSpeakers: form.maxSpeakers,
    maxBioLength: form.maxBioLength,
    published: form.published,
    fields: form.fields.map<DraftField>((f) => ({
      localId: nextLocalId(),
      key: f.key,
      label: f.label,
      helpText: f.helpText,
      type: f.type,
      required: f.required,
      options: f.options,
      conditionalLogic: f.conditionalLogic,
    })),
  };
}

type Draft = ReturnType<typeof toDraft>;

export function FormBuilder({
  form: initial,
  eventId,
  timezone,
  publicFormPath,
}: {
  form: BuilderForm;
  eventId: string;
  timezone: string;
  publicFormPath: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [step, setStep] = useState<Step>("fields");
  const [openField, setOpenField] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);

  function patch(p: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...p }));
    setSaved(false);
  }
  function patchField(localId: string, p: Partial<DraftField>) {
    setDraft((d) => ({
      ...d,
      fields: d.fields.map((f) => (f.localId === localId ? { ...f, ...p } : f)),
    }));
    setSaved(false);
  }
  function addField() {
    const localId = nextLocalId();
    setDraft((d) => ({
      ...d,
      fields: [
        ...d.fields,
        {
          localId,
          key: `question_${d.fields.length + 1}`,
          label: "New question",
          helpText: null,
          type: "SHORT_TEXT",
          required: false,
          options: null,
          conditionalLogic: null,
        },
      ],
    }));
    setOpenField(localId);
    setStep("fields");
    setSaved(false);
  }
  function removeField(localId: string) {
    setDraft((d) => ({ ...d, fields: d.fields.filter((f) => f.localId !== localId) }));
    setSaved(false);
  }
  function move(localId: string, dir: -1 | 1) {
    setDraft((d) => {
      const idx = d.fields.findIndex((f) => f.localId === localId);
      const j = idx + dir;
      if (idx < 0 || j < 0 || j >= d.fields.length) return d;
      const fields = [...d.fields];
      [fields[idx], fields[j]] = [fields[j], fields[idx]];
      return { ...d, fields };
    });
    setSaved(false);
  }

  /** Client-side guards for the contract's regex rules, before the round trip. */
  function localValidate(): boolean {
    const errs: Record<string, string> = {};
    if (!SLUG_RE.test(draft.slug)) errs.slug = "Lowercase letters, numbers and single dashes only.";
    if (draft.name.trim().length === 0) errs.name = "Name is required.";
    if (draft.minSpeakers > draft.maxSpeakers) errs.maxSpeakers = "Must be at least the minimum.";
    if (draft.opensAt && draft.closesAt && new Date(draft.opensAt) >= new Date(draft.closesAt)) {
      errs.closesAt = "Must be after the open date.";
    }
    const seen = new Set<string>();
    for (const f of draft.fields) {
      if (!KEY_RE.test(f.key)) errs[`field.${f.localId}`] = `Key "${f.key}" must be lowercase, starting with a letter.`;
      if (seen.has(f.key)) errs[`field.${f.localId}`] = `Duplicate key "${f.key}".`;
      seen.add(f.key);
      if (HAS_OPTIONS.includes(f.type) && (!f.options || f.options.length === 0)) {
        errs[`field.${f.localId}`] = `"${f.label}" needs at least one option.`;
      }
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function save() {
    setError(null);
    if (!localValidate()) {
      setError("Fix the highlighted problems and try again.");
      return;
    }
    setSaving(true);
    const payload = {
      eventId,
      id: initial.id,
      name: draft.name.trim(),
      slug: draft.slug,
      welcomeText: draft.welcomeText.trim() || undefined,
      thankYouText: draft.thankYouText.trim() || undefined,
      opensAt: draft.opensAt ?? undefined,
      closesAt: draft.closesAt ?? undefined,
      submissionLimit: draft.submissionLimit ?? undefined,
      minSpeakers: draft.minSpeakers,
      maxSpeakers: draft.maxSpeakers,
      maxBioLength: draft.maxBioLength,
      published: draft.published,
      // No field `id`: the API upserts by (formConfigId, key).
      fields: draft.fields.map((f, i) => ({
        key: f.key,
        label: f.label,
        helpText: f.helpText ?? undefined,
        type: f.type,
        required: f.required,
        options: f.options ?? undefined,
        conditionalLogic: f.conditionalLogic ?? undefined,
        sortOrder: i,
      })),
    };

    const res = await apiPost("/api/cfp/forms", payload);
    setSaving(false);
    if (!res.ok) {
      setError(res.error.message);
      setFieldErrors(firstFieldErrors(res.error.fieldErrors));
      return;
    }
    setSaved(true);
    setFieldErrors({});
    startTransition(() => router.refresh());
  }

  return (
    <div className="page-stack" style={{ width: "min(1280px, 100%)" }}>
      <div className="row wrap" style={{ justifyContent: "space-between" }}>
        <div>
          <Link href="/admin/forms" className="link-button row" style={{ gap: 6, marginBottom: 6 }}>
            <ArrowLeft size={14} /> Back to forms
          </Link>
          <h1 style={{ margin: 0, fontSize: 24 }}>Edit form</h1>
          <p className="hint">{draft.name}</p>
        </div>
        <div className="row wrap">
          <Link className="ghost-button" href={publicFormPath} target="_blank">
            <ExternalLink size={15} /> View form
          </Link>
          <button
            className="ghost-button"
            type="button"
            onClick={async () => {
              await navigator.clipboard?.writeText(`${location.origin}${publicFormPath}`);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Link copied" : "Copy link"}
          </button>
          <button className="primary-button" type="button" onClick={save} disabled={saving || pending} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            {saved ? <Check size={16} /> : <Save size={16} />}
            {saving ? "Saving…" : saved ? "Saved" : "Save"}
          </button>
        </div>
      </div>

      {error ? <div className="conflict-banner" role="alert">{error}</div> : null}

      <div className="card builder">
        <nav className="builder-nav" aria-label="Form setup steps">
          <p className="nav-eyebrow">Form setup</p>
          {STEPS.map((s) => {
            const Icon = s.icon;
            return (
              <button key={s.key} type="button" className={`builder-step ${step === s.key ? "active" : ""}`} aria-current={step === s.key} onClick={() => setStep(s.key)}>
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

        <div className="builder-panel">
          {step === "welcome" && <WelcomeStep draft={draft} patch={patch} errors={fieldErrors} />}
          {step === "fields" && (
            <FieldsStep
              draft={draft}
              errors={fieldErrors}
              openField={openField}
              setOpenField={setOpenField}
              patchField={patchField}
              addField={addField}
              removeField={removeField}
              move={move}
            />
          )}
          {step === "settings" && <SettingsStep draft={draft} patch={patch} errors={fieldErrors} timezone={timezone} />}
        </div>

        <aside className="builder-preview" aria-label="Live preview">
          <p className="preview-eyebrow">Live preview</p>
          <Preview draft={draft} />
        </aside>
      </div>
    </div>
  );
}

function WelcomeStep({ draft, patch, errors }: { draft: Draft; patch: (p: Partial<Draft>) => void; errors: Record<string, string> }) {
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div><h2>Welcome screen</h2><p className="hint">The first screen a submitter sees.</p></div>
      <div className="grid-2">
        <label className="stack">
          <span className="field-label">Form name</span>
          <input className="text-input" value={draft.name} aria-invalid={!!errors.name} onChange={(e) => patch({ name: e.target.value })} />
          {errors.name ? <span className="field-error">{errors.name}</span> : null}
        </label>
        <label className="stack">
          <span className="field-label">Public URL slug</span>
          <input className="text-input" value={draft.slug} aria-invalid={!!errors.slug} onChange={(e) => patch({ slug: e.target.value })} />
          {errors.slug ? <span className="field-error">{errors.slug}</span> : null}
        </label>
      </div>
      <label className="stack">
        <span className="field-label">Welcome message</span>
        <textarea className="text-input" rows={6} value={draft.welcomeText} onChange={(e) => patch({ welcomeText: e.target.value })} />
      </label>
      <label className="stack">
        <span className="field-label">Thank-you message</span>
        <textarea className="text-input" rows={3} value={draft.thankYouText} onChange={(e) => patch({ thankYouText: e.target.value })} />
      </label>
    </div>
  );
}

function FieldsStep({
  draft,
  errors,
  openField,
  setOpenField,
  patchField,
  addField,
  removeField,
  move,
}: {
  draft: Draft;
  errors: Record<string, string>;
  openField: string | null;
  setOpenField: (id: string | null) => void;
  patchField: (localId: string, p: Partial<DraftField>) => void;
  addField: () => void;
  removeField: (localId: string) => void;
  move: (localId: string, dir: -1 | 1) => void;
}) {
  return (
    <div className="stack" style={{ gap: 16 }}>
      {/* `wrap`: Add field must never be pushed sideways out of this column,
          where the sticky preview would paint over it and eat the click. */}
      <div className="row wrap" style={{ justifyContent: "space-between" }}>
        <div><h2>Form questions</h2><p className="hint">Custom questions asked in addition to title, abstract, format and category.</p></div>
        <button className="ghost-button" type="button" onClick={addField}><Plus size={15} /> Add field</button>
      </div>

      {draft.fields.length === 0 ? <p className="hint">No custom questions yet.</p> : null}

      {draft.fields.map((field, i) => {
        const open = openField === field.localId;
        const err = errors[`field.${field.localId}`];
        return (
          <div className="field-editor" key={field.localId} style={err ? { borderColor: "#d98b7c" } : undefined}>
            <div className="field-editor-head">
              <span className="drag" aria-hidden="true"><GripVertical size={16} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <button type="button" className="link-button" onClick={() => setOpenField(open ? null : field.localId)} style={{ color: "var(--ink)", fontWeight: 600 }}>
                  {field.label || "Untitled question"}
                </button>
                <p className="hint">
                  {FIELD_TYPES.find((t) => t.value === field.type)?.label}
                  {field.required ? " · Required" : ""}
                  {field.conditionalLogic ? " · Conditional" : ""}
                  {` · key: ${field.key}`}
                </p>
                {err ? <p className="field-error">{err}</p> : null}
              </div>
              <div className="row wrap" style={{ gap: 4 }}>
                <button className="ghost-button" type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(field.localId, -1)}>↑</button>
                <button className="ghost-button" type="button" aria-label="Move down" disabled={i === draft.fields.length - 1} onClick={() => move(field.localId, 1)}>↓</button>
                <span className="row" style={{ gap: 6 }}>
                  <Switch checked={field.required} onChange={(v) => patchField(field.localId, { required: v })} label="Required" />
                  <span className="hint">Required</span>
                </span>
                <button className="ghost-button danger-button" type="button" aria-label="Delete field" onClick={() => removeField(field.localId)}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            {open && (
              <div className="field-editor-body">
                <div className="grid-2">
                  <label className="stack">
                    <span className="field-label">Label</span>
                    <input className="text-input" value={field.label} onChange={(e) => patchField(field.localId, { label: e.target.value })} />
                  </label>
                  <label className="stack">
                    <span className="field-label">Field key</span>
                    <input className="text-input" value={field.key} onChange={(e) => patchField(field.localId, { key: e.target.value })} />
                    <span className="hint">Stable identifier for answers. Lowercase, no spaces.</span>
                  </label>
                </div>
                <label className="stack">
                  <span className="field-label">Field type</span>
                  <select className="select-input" value={field.type} onChange={(e) => patchField(field.localId, { type: e.target.value as FieldType })}>
                    {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </label>
                <label className="stack">
                  <span className="field-label">Help text</span>
                  <input className="text-input" value={field.helpText ?? ""} onChange={(e) => patchField(field.localId, { helpText: e.target.value })} />
                </label>

                {HAS_OPTIONS.includes(field.type) && (
                  <label className="stack">
                    <span className="field-label">Options (one per line)</span>
                    <textarea
                      className="text-input"
                      rows={3}
                      value={(field.options ?? []).map((o) => o.label).join("\n")}
                      onChange={(e) =>
                        patchField(field.localId, {
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

                <LogicEditor draft={draft} field={field} patchField={patchField} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function LogicEditor({
  draft,
  field,
  patchField,
}: {
  draft: Draft;
  field: DraftField;
  patchField: (localId: string, p: Partial<DraftField>) => void;
}) {
  const logic = field.conditionalLogic;
  const others = draft.fields.filter((f) => f.localId !== field.localId);

  if (!logic) {
    return (
      <button
        className="link-button"
        type="button"
        disabled={others.length === 0}
        onClick={() =>
          patchField(field.localId, {
            conditionalLogic: { match: "all", rules: [{ fieldKey: others[0]?.key ?? "", operator: "equals", value: "" }] },
          })
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
        <button className="link-button" type="button" onClick={() => patchField(field.localId, { conditionalLogic: null })}>Remove</button>
      </div>
      {logic.rules.map((rule, ri) => (
        <div className="grid-2" key={ri}>
          <select
            className="select-input"
            value={rule.fieldKey}
            onChange={(e) => {
              const rules = logic.rules.map((r, i) => (i === ri ? { ...r, fieldKey: e.target.value } : r));
              patchField(field.localId, { conditionalLogic: { ...logic, rules } });
            }}
          >
            {others.map((o) => <option key={o.localId} value={o.key}>{o.label}</option>)}
          </select>
          <div className="row" style={{ gap: 8 }}>
            <select
              className="select-input"
              value={rule.operator}
              onChange={(e) => {
                const rules = logic.rules.map((r, i) => (i === ri ? { ...r, operator: e.target.value } : r));
                patchField(field.localId, { conditionalLogic: { ...logic, rules } });
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
                  patchField(field.localId, { conditionalLogic: { ...logic, rules } });
                }}
              />
            )}
          </div>
        </div>
      ))}
      <p className="hint">Values match the option value, e.g. <code>advanced</code>.</p>
    </div>
  );
}

function SettingsStep({ draft, patch, errors, timezone }: { draft: Draft; patch: (p: Partial<Draft>) => void; errors: Record<string, string>; timezone: string }) {
  const toIso = (date: string, endOfDay: boolean) =>
    date ? zonedToUtcIso(date, endOfDay ? "23:59" : "00:00", timezone) : null;
  const dateKey = (iso: string | null) => (iso ? zonedParts(iso, timezone).dateKey : "");

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div><h2>Form settings</h2><p className="hint">Deadlines, limits, and speaker constraints — all enforced server-side on submit.</p></div>
      <div className="grid-2">
        <label className="stack">
          <span className="field-label">Opens at</span>
          <input type="date" className="text-input" value={dateKey(draft.opensAt)} onChange={(e) => patch({ opensAt: toIso(e.target.value, false) })} />
        </label>
        <label className="stack">
          <span className="field-label">Closes at</span>
          <input type="date" className="text-input" value={dateKey(draft.closesAt)} aria-invalid={!!errors.closesAt} onChange={(e) => patch({ closesAt: toIso(e.target.value, true) })} />
          {errors.closesAt ? <span className="field-error">{errors.closesAt}</span> : null}
        </label>
      </div>
      <div className="grid-2">
        <label className="stack">
          <span className="field-label">Submission limit per user</span>
          <input type="number" min={1} className="text-input" value={draft.submissionLimit ?? ""} onChange={(e) => patch({ submissionLimit: e.target.value ? Number(e.target.value) : null })} />
        </label>
        <label className="stack">
          <span className="field-label">Max bio length</span>
          <input type="number" min={100} max={10000} className="text-input" value={draft.maxBioLength} onChange={(e) => patch({ maxBioLength: Number(e.target.value) })} />
        </label>
      </div>
      <div className="grid-2">
        <label className="stack">
          <span className="field-label">Min speakers</span>
          <input type="number" min={1} max={20} className="text-input" value={draft.minSpeakers} onChange={(e) => patch({ minSpeakers: Number(e.target.value) })} />
        </label>
        <label className="stack">
          <span className="field-label">Max speakers</span>
          <input type="number" min={1} max={20} className="text-input" value={draft.maxSpeakers} aria-invalid={!!errors.maxSpeakers} onChange={(e) => patch({ maxSpeakers: Number(e.target.value) })} />
          {errors.maxSpeakers ? <span className="field-error">{errors.maxSpeakers}</span> : null}
        </label>
      </div>
      <div className="card" style={{ padding: 16 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div><span className="field-label">Published</span><p className="hint">Public submissions are accepted while published and inside the window.</p></div>
          <Switch checked={draft.published} onChange={(v) => patch({ published: v })} label="Published" />
        </div>
      </div>
    </div>
  );
}

function Preview({ draft }: { draft: Draft }) {
  const [answers, setAnswers] = useState<AnswerMap>({});
  const asFields = useMemo(
    () =>
      draft.fields.map((f) => ({
        id: f.localId,
        key: f.key,
        label: f.label,
        helpText: f.helpText ?? undefined,
        type: f.type,
        required: f.required,
        options: f.options ?? undefined,
        conditionalLogic: f.conditionalLogic ?? undefined,
      })),
    [draft.fields],
  );
  const visible = useMemo(() => resolveVisibleFields(asFields, answers), [asFields, answers]);
  const hiddenCount = asFields.length - visible.length;

  return (
    <div className="card" style={{ padding: 16, background: "white" }}>
      <p className="eyebrow">{draft.name}</p>
      {draft.welcomeText ? (
        <p className="hint" style={{ marginBottom: 14 }}>
          {draft.welcomeText.slice(0, 140)}{draft.welcomeText.length > 140 ? "…" : ""}
        </p>
      ) : null}
      <p className="hint" style={{ marginBottom: 14 }}>Title, abstract, format and category are always collected.</p>
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
