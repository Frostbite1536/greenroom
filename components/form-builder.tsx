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
import { resolveVisibleFields, withBuiltInAnswers, type AnswerMap } from "@/lib/form-logic";
import { apiPost } from "@/lib/api-client";
import { zonedParts, zonedToUtcIso } from "@/lib/tz";
import { Switch } from "@/components/ui";
import { DEFAULT_SESSION_FORMAT, SESSION_FORMATS } from "@/lib/cfp-formats";
import {
  findFormShapeIssues,
  formShapeFieldErrors,
  type ShapeField,
} from "@/lib/services/form-shape-validation";
import {
  OPERATOR_LABELS,
  addOption,
  defaultRule,
  findRuleSource,
  initialPreviewBuiltIns,
  normalizeOptions,
  operatorNeedsValue,
  previewBuiltInAnswers,
  relabelOption,
  removeOption,
  retargetRule,
  ruleSources,
  type PreviewBuiltIns,
  type RuleSource,
} from "@/lib/form-builder-logic";

/** Event-scoped categories, so the preview can answer the built-in Topic question. */
export type BuilderCategory = { id: string; name: string };

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
      // Loaded values are never regenerated — only a stored option that somehow
      // has no value at all is given one, because the server now refuses it.
      options: f.options ? normalizeOptions(f.options) : null,
      conditionalLogic: f.conditionalLogic,
    })),
  };
}

type Draft = ReturnType<typeof toDraft>;

/** Errors are per key and there can be several; the builder shows all of them. */
type ErrorMap = Record<string, string[]>;

const errorKey = (localId: string) => `field.${localId}`;

function FieldErrors({ messages, id }: { messages?: string[]; id?: string }) {
  if (!messages || messages.length === 0) return null;
  return (
    <span className="field-error" id={id} role="alert">
      {messages.map((message, i) => (
        <span key={i} style={{ display: "block" }}>{message}</span>
      ))}
    </span>
  );
}

/** The payload slice the shared server validator reads, from the live draft. */
function toShapeFields(draft: Draft): ShapeField[] {
  return draft.fields.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    options: field.options ?? undefined,
    conditionalLogic: field.conditionalLogic ?? undefined,
  }));
}

export function FormBuilder({
  form: initial,
  eventId,
  timezone,
  publicFormPath,
  categories = [],
}: {
  form: BuilderForm;
  eventId: string;
  timezone: string;
  publicFormPath: string;
  categories?: BuilderCategory[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [step, setStep] = useState<Step>("fields");
  const [openField, setOpenField] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<ErrorMap>({});
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

  /**
   * Everything the save would be refused for, before the round trip.
   *
   * The shape rules are not restated here: `findFormShapeIssues` is the exact
   * module the route runs, so a rule with no value, an orphan source, a blank or
   * duplicated option value, a reserved key or a dependency cycle is reported in
   * the same words the server would use. Only the regex/range rules the shared
   * module does not cover are checked locally. This is guidance, never
   * enforcement — the server runs the same check again and wins.
   */
  function localValidate(): ErrorMap {
    const errs: ErrorMap = {};
    const add = (key: string, message: string) => {
      (errs[key] ??= []).push(message);
    };
    if (!SLUG_RE.test(draft.slug)) add("slug", "Lowercase letters, numbers and single dashes only.");
    if (draft.name.trim().length === 0) add("name", "Name is required.");
    if (draft.minSpeakers > draft.maxSpeakers) add("maxSpeakers", "Must be at least the minimum.");
    if (draft.opensAt && draft.closesAt && new Date(draft.opensAt) >= new Date(draft.closesAt)) {
      add("closesAt", "Must be after the open date.");
    }
    const seen = new Set<string>();
    for (const f of draft.fields) {
      if (!KEY_RE.test(f.key)) add(errorKey(f.localId), `Key "${f.key}" must be lowercase, starting with a letter.`);
      if (seen.has(f.key)) add(errorKey(f.localId), `Duplicate key "${f.key}".`);
      seen.add(f.key);
      if (HAS_OPTIONS.includes(f.type) && (!f.options || f.options.length === 0)) {
        add(errorKey(f.localId), `"${f.label}" needs at least one option.`);
      }
    }
    const shape = byLocalId(formShapeFieldErrors(findFormShapeIssues(toShapeFields(draft))));
    for (const [key, messages] of Object.entries(shape)) {
      for (const message of messages) add(key, message);
    }
    setFieldErrors(errs);
    return errs;
  }

  /**
   * Field-scoped server errors arrive keyed by the payload's field *key*
   * (`FORM_LOGIC_*`, `FORM_OPTION_*`, `FORM_FIELD_KEY_RESERVED`, and the
   * answered-field refusals). The editor renders by `localId`, so without this
   * translation those messages landed under a key nothing reads and the save
   * failed with a banner and no indication of which question was wrong.
   */
  function byLocalId(fieldErrors: Record<string, string[]> | undefined): ErrorMap {
    const byKey = new Map(draft.fields.map((f) => [f.key, f.localId]));
    const mapped: ErrorMap = {};
    for (const [key, messages] of Object.entries(fieldErrors ?? {})) {
      const localId = byKey.get(key);
      mapped[localId ? errorKey(localId) : key] = [...messages];
    }
    return mapped;
  }

  async function save() {
    setError(null);
    const problems = localValidate();
    if (Object.keys(problems).length > 0) {
      const offending = Object.keys(problems).find((key) => key.startsWith("field."));
      if (offending) {
        setStep("fields");
        setOpenField(offending.slice("field.".length));
      }
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
      const inline = byLocalId(res.error.fieldErrors);
      setFieldErrors(inline);
      const offending = Object.keys(inline).find((key) => key.startsWith("field."));
      if (offending) setOpenField(offending.slice("field.".length));
      setError(
        Object.keys(inline).length > 0
          ? `${res.error.message} The affected questions are marked below.`
          : res.error.message,
      );
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
              // A missing or permission-denied clipboard used to still flip the
              // label to "Link copied" — a confirmation for something that
              // never happened, and an unhandled rejection besides.
              try {
                if (!navigator.clipboard) throw new Error("no clipboard");
                await navigator.clipboard.writeText(`${location.origin}${publicFormPath}`);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {
                setError("Could not copy the link — your browser blocked clipboard access. Open the form and copy the address bar instead.");
              }
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
      {/* The button's own label was the only success signal, and a label swap
          is not announced. This is the same confirmation, in a live region. */}
      <p className="sr-only" role="status" aria-live="polite">{saved ? "Form saved." : ""}</p>

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
              categories={categories}
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
          <Preview draft={draft} categories={categories} />
        </aside>
      </div>
    </div>
  );
}

function WelcomeStep({ draft, patch, errors }: { draft: Draft; patch: (p: Partial<Draft>) => void; errors: ErrorMap }) {
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div><h2>Welcome screen</h2><p className="hint">The first screen a submitter sees.</p></div>
      <div className="grid-2">
        <label className="stack">
          <span className="field-label">Form name</span>
          <input className="text-input" value={draft.name} aria-invalid={!!errors.name} onChange={(e) => patch({ name: e.target.value })} />
          <FieldErrors messages={errors.name} />
        </label>
        <label className="stack">
          <span className="field-label">Public URL slug</span>
          <input className="text-input" value={draft.slug} aria-invalid={!!errors.slug} onChange={(e) => patch({ slug: e.target.value })} />
          <FieldErrors messages={errors.slug} />
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
  categories,
  errors,
  openField,
  setOpenField,
  patchField,
  addField,
  removeField,
  move,
}: {
  draft: Draft;
  categories: BuilderCategory[];
  errors: ErrorMap;
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
        const err = errors[errorKey(field.localId)];
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
                <FieldErrors messages={err} id={`${field.localId}-errors`} />
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
                  <OptionsEditor field={field} patchField={patchField} />
                )}

                <LogicEditor draft={draft} categories={categories} field={field} patchField={patchField} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * One choice per row, with its stored value shown and not editable.
 *
 * The old editor was a textarea of labels and rebuilt every value from its
 * label on each keystroke, so fixing a typo silently rewrote the value that
 * every stored answer and every rule pointed at. Values are generated once, on
 * creation, and never move afterwards.
 */
function OptionsEditor({
  field,
  patchField,
}: {
  field: DraftField;
  patchField: (localId: string, p: Partial<DraftField>) => void;
}) {
  const options = field.options ?? [];
  const set = (next: { label: string; value: string }[]) =>
    patchField(field.localId, { options: next });

  return (
    <div className="stack">
      <span className="field-label">Choices</span>
      <p className="hint">
        Answers are stored by value, so a choice keeps its value when you reword it. Rules match the
        value, not the wording.
      </p>
      {options.length === 0 ? <p className="hint">No choices yet.</p> : null}
      {options.map((option, i) => (
        <div className="row" key={option.value} style={{ gap: 8 }}>
          <input
            className="text-input"
            aria-label={`Choice ${i + 1} wording`}
            value={option.label}
            onChange={(e) => set(relabelOption(options, i, e.target.value))}
          />
          <code className="hint" style={{ whiteSpace: "nowrap" }}>{option.value}</code>
          <button
            className="ghost-button danger-button"
            type="button"
            aria-label={`Remove choice ${i + 1}`}
            onClick={() => set(removeOption(options, i))}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button className="ghost-button" type="button" style={{ justifySelf: "start" }} onClick={() => set(addOption(options))}>
        <Plus size={14} /> Add choice
      </button>
    </div>
  );
}

function LogicEditor({
  draft,
  categories,
  field,
  patchField,
}: {
  draft: Draft;
  categories: BuilderCategory[];
  field: DraftField;
  patchField: (localId: string, p: Partial<DraftField>) => void;
}) {
  const logic = field.conditionalLogic;
  // Built-in submission questions come from the server's own inventory, so the
  // builder cannot offer a source the shape validator would reject — and cannot
  // omit one it accepts. `format` is why this exists: a rule on it used to be
  // unwritable here even though every submission answers it.
  const sources = useMemo(
    () =>
      ruleSources(
        draft.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options })),
        field.key,
        {
          format: SESSION_FORMATS.map((entry) => ({ label: entry.label, value: entry.value })),
          // Convenience only: the server checks the key, never the value, and
          // categories outlive any list captured at save time — so an id that
          // is no longer here stays editable rather than being rewritten.
          categoryId: categories.map((category) => ({ label: category.name, value: category.id })),
        },
      ),
    [draft.fields, field.key, categories],
  );

  if (!logic) {
    return (
      <button
        className="link-button"
        type="button"
        onClick={() =>
          patchField(field.localId, {
            // Seeded with a rule that is already valid — see `defaultRule`.
            conditionalLogic: { match: "all", rules: [defaultRule(sources[0])] },
          })
        }
      >
        + Add conditional logic (only show this field when…)
      </button>
    );
  }

  const patchRule = (index: number, next: { fieldKey: string; operator: string; value?: string | number | boolean }) => {
    const rules = logic.rules.map((rule, i) => (i === index ? next : rule));
    patchField(field.localId, { conditionalLogic: { ...logic, rules } });
  };

  return (
    <div className="logic-box">
      <div className="row wrap" style={{ justifyContent: "space-between" }}>
        <span className="field-label">Only show when…</span>
        <button className="link-button" type="button" onClick={() => patchField(field.localId, { conditionalLogic: null })}>Remove</button>
      </div>
      {logic.rules.map((rule, ri) => {
        const source = findRuleSource(sources, rule.fieldKey);
        const needsValue = operatorNeedsValue(rule.operator);
        const rawValue = rule.value === undefined ? "" : String(rule.value);
        const missingValue = needsValue && rawValue.trim().length === 0;
        return (
          <div className="stack" key={ri} style={{ gap: 6 }}>
            <div className="grid-2">
              <select
                className="select-input"
                aria-label="Question this rule watches"
                value={rule.fieldKey}
                onChange={(e) => {
                  const next = findRuleSource(sources, e.target.value);
                  if (next) patchRule(ri, retargetRule(rule, next));
                }}
              >
                {/* A source the payload names but this form no longer has still
                    has to be shown, or changing it would be impossible. */}
                {!source ? <option value={rule.fieldKey}>{rule.fieldKey} (missing)</option> : null}
                <optgroup label="Built-in questions">
                  {sources.filter((s) => s.builtIn).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </optgroup>
                <optgroup label="Questions on this form">
                  {sources.filter((s) => !s.builtIn).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </optgroup>
              </select>
              <div className="row wrap" style={{ gap: 8 }}>
                <select
                  className="select-input"
                  aria-label="Condition"
                  value={rule.operator}
                  onChange={(e) => patchRule(ri, retargetRule({ ...rule, operator: e.target.value }, source ?? sources[0]))}
                  style={{ flex: "1 1 130px", width: "auto" }}
                >
                  {(source?.operators ?? []).map((operator) => (
                    <option key={operator} value={operator}>{OPERATOR_LABELS[operator]}</option>
                  ))}
                  {source && !(source.operators as readonly string[]).includes(rule.operator) ? (
                    <option value={rule.operator}>{rule.operator} (unsupported)</option>
                  ) : null}
                </select>
                {needsValue ? <RuleValueInput source={source} value={rawValue} onChange={(value) => patchRule(ri, { ...rule, value })} /> : null}
              </div>
            </div>
            {/* Guidance, not enforcement: the same refusal is
                `FORM_LOGIC_VALUE_MISSING` server-side, and Save blocks on it. */}
            {missingValue ? (
              <p className="field-error" role="alert">
                Pick the answer this rule should look for, or change it to “{OPERATOR_LABELS.isNotEmpty}”.
              </p>
            ) : null}
          </div>
        );
      })}
      <p className="hint">
        A rule on a built-in question compares what the submitter chose on the submission itself.
      </p>
    </div>
  );
}

/** A picker when the source has a known value set, free text when it does not. */
function RuleValueInput({
  source,
  value,
  onChange,
}: {
  source: RuleSource | null;
  value: string;
  onChange: (value: string) => void;
}) {
  const choices = source?.optionValues ?? null;
  if (!choices) {
    return (
      <input
        className="text-input"
        aria-label="Value to match"
        placeholder="value"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ flex: "1 1 130px", width: "auto" }}
      />
    );
  }
  return (
    <select
      className="select-input"
      aria-label="Value to match"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ flex: "1 1 130px", width: "auto" }}
    >
      {/* Never silently valid: an empty selection is what the server refuses. */}
      <option value="">Choose an answer…</option>
      {choices.some((choice) => choice.value === value) || value.length === 0 ? null : (
        <option value={value}>{value} (not a choice)</option>
      )}
      {choices.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.label.trim().length > 0 ? choice.label : choice.value}
        </option>
      ))}
    </select>
  );
}

function SettingsStep({ draft, patch, errors, timezone }: { draft: Draft; patch: (p: Partial<Draft>) => void; errors: ErrorMap; timezone: string }) {
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
          <FieldErrors messages={errors.closesAt} />
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
          <FieldErrors messages={errors.maxSpeakers} />
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

function Preview({ draft, categories }: { draft: Draft; categories: BuilderCategory[] }) {
  const [answers, setAnswers] = useState<AnswerMap>({});
  // The built-in questions are real inputs here, not a sentence about them: a
  // rule is only previewable if the preview can answer its source, and these
  // start where the public form starts so the first paint agrees.
  const [builtIns, setBuiltIns] = useState<PreviewBuiltIns>(() => initialPreviewBuiltIns(DEFAULT_SESSION_FORMAT));
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
  // The same call the public form makes, so the two cannot drift.
  const visible = useMemo(
    () => resolveVisibleFields(asFields, withBuiltInAnswers(answers, previewBuiltInAnswers(builtIns))),
    [asFields, answers, builtIns],
  );
  const hiddenCount = asFields.length - visible.length;
  const patchBuiltIn = (patch: Partial<PreviewBuiltIns>) => setBuiltIns((current) => ({ ...current, ...patch }));

  return (
    <div className="card" style={{ padding: 16, background: "white" }}>
      <p className="eyebrow">{draft.name}</p>
      {draft.welcomeText ? (
        <p className="hint" style={{ marginBottom: 14 }}>
          {draft.welcomeText.slice(0, 140)}{draft.welcomeText.length > 140 ? "…" : ""}
        </p>
      ) : null}
      {/* Every built-in the rule picker offers as a source gets a control here.
          A source the picker offers but the preview cannot answer would sit at
          an empty default forever, and the preview would disagree with the
          public form for exactly the rules the builder just made writable. */}
      <p className="hint" style={{ marginBottom: 14 }}>
        Title, abstract, format, category and speakers are always collected. Change them to see
        conditional questions appear.
      </p>
      <label className="stack" style={{ marginBottom: 12 }}>
        <span className="field-label">Session title</span>
        <input className="text-input" value={builtIns.title} onChange={(e) => patchBuiltIn({ title: e.target.value })} />
      </label>
      <label className="stack" style={{ marginBottom: 12 }}>
        <span className="field-label">Abstract</span>
        <textarea className="text-input" rows={2} value={builtIns.abstract} onChange={(e) => patchBuiltIn({ abstract: e.target.value })} />
      </label>
      <label className="stack" style={{ marginBottom: 12 }}>
        <span className="field-label">Session format</span>
        <select className="select-input" value={builtIns.format} onChange={(e) => patchBuiltIn({ format: e.target.value })}>
          {SESSION_FORMATS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
        </select>
      </label>
      {categories.length > 0 ? (
        <label className="stack" style={{ marginBottom: 12 }}>
          <span className="field-label">Topic category</span>
          <select className="select-input" value={builtIns.categoryId} onChange={(e) => patchBuiltIn({ categoryId: e.target.value })}>
            <option value="">Select…</option>
            {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
        </label>
      ) : (
        <p className="hint" style={{ marginBottom: 12 }}>
          This event has no categories yet, so the built-in Topic category question has nothing to pick.
        </p>
      )}
      <label className="stack" style={{ marginBottom: 14 }}>
        {/* The roster is presence-only, so a count is all a rule can read. */}
        <span className="field-label">Speakers added</span>
        <input
          type="number"
          min={0}
          max={20}
          className="text-input"
          value={builtIns.speakerCount}
          onChange={(e) => patchBuiltIn({ speakerCount: Number(e.target.value) })}
        />
      </label>
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
