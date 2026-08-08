"use client";

import { useMemo, useState } from "react";
import { Check, Mail, RotateCcw } from "lucide-react";
import { previewTemplate, TEMPLATE_VARIABLES, unknownTemplateVariables } from "@/lib/comms/template-edit";
import styles from "./operations.module.css";

type Template = {
  id: string;
  key: string;
  subject: string;
  trigger: string | null;
  /** Already sanitized on the server before it reached this component. */
  htmlBody: string;
  updatedAt: string;
};

type Saved = { tone: "good" | "warn" | "bad"; headline: string; note?: string };

/**
 * Read and edit the wording each reminder sends.
 *
 * The preview uses the same pure renderer as the server (`previewTemplate`
 * sanitizes, then substitutes escaped sample values), so what an operator sees
 * here is what a speaker receives — including the fact that an unrecognised
 * placeholder renders as nothing, which is why unknown names are warned about
 * while typing rather than after sending.
 */
export function TemplatesPanel({ templates: initial }: { templates: Template[] }) {
  const [templates, setTemplates] = useState(initial);
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <section className={styles.panel} aria-labelledby="ops-templates">
      <div className={styles.panelHead}>
        <h2 id="ops-templates">What your speakers receive</h2>
        <p>The wording used by each reminder. Edit it and see exactly how it will look.</p>
      </div>

      {templates.length === 0 ? (
        <p className={styles.empty}>No email templates exist for this event yet.</p>
      ) : (
        templates.map((template) => (
          <TemplateItem
            key={template.id}
            template={template}
            open={openId === template.id}
            onToggle={() => setOpenId(openId === template.id ? null : template.id)}
            onSaved={(updated) =>
              setTemplates((current) => current.map((item) => (item.id === updated.id ? updated : item)))
            }
          />
        ))
      )}
    </section>
  );
}

function TemplateItem({
  template,
  open,
  onToggle,
  onSaved,
}: {
  template: Template;
  open: boolean;
  onToggle: () => void;
  onSaved: (template: Template) => void;
}) {
  const [subject, setSubject] = useState(template.subject);
  const [htmlBody, setHtmlBody] = useState(template.htmlBody);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Saved | null>(null);

  const preview = useMemo(() => previewTemplate({ subject, htmlBody }), [subject, htmlBody]);
  const unknown = useMemo(() => unknownTemplateVariables(subject, htmlBody), [subject, htmlBody]);
  const dirty = subject !== template.subject || htmlBody !== template.htmlBody;

  function reset() {
    setSubject(template.subject);
    setHtmlBody(template.htmlBody);
    setSaved(null);
  }

  async function save() {
    setBusy(true);
    setSaved(null);
    try {
      const res = await fetch(`/api/comms/templates/${template.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, htmlBody, trigger: template.trigger }),
      });
      const body = await res.json();
      if (!body?.ok) {
        const fieldMessage = Object.values(body?.error?.fieldErrors ?? {}).flat()[0] as string | undefined;
        setSaved({ tone: "bad", headline: fieldMessage ?? body?.error?.message ?? "That could not be saved." });
        return;
      }
      const updated = { ...body.data.template, updatedAt: String(body.data.template.updatedAt) } as Template;
      setSubject(updated.subject);
      setHtmlBody(updated.htmlBody);
      onSaved(updated);
      setSaved({
        tone: body.data.sanitized || body.data.unknownVariables.length > 0 ? "warn" : "good",
        headline: "Saved. Reminders will use this wording from now on.",
        note: body.data.sanitized
          ? "Some formatting isn't supported in email and was removed — the text above is exactly what will be sent."
          : body.data.unknownVariables.length > 0
            ? `${body.data.unknownVariables.map((name: string) => `{{${name}}}`).join(", ")} will appear empty — nothing fills those in.`
            : undefined,
      });
    } catch {
      setSaved({ tone: "bad", headline: "We couldn't reach the server. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.templateItem}>
      <div className="row wrap">
        <Mail size={15} aria-hidden="true" />
        <strong>{template.subject}</strong>
        {template.trigger ? <span className="pill neutral">{template.trigger.replace(/_/g, " ").toLowerCase()}</span> : null}
      </div>
      <span className={styles.templateKey}>Used by reminders as “{template.key}”</span>
      <div className={styles.actions}>
        <button className="ghost-button" type="button" aria-expanded={open} onClick={onToggle}>
          {open ? "Close" : "Edit and preview"}
        </button>
      </div>

      {open ? (
        <>
          <div className={styles.field}>
            <label className="field-label" htmlFor={`subject-${template.id}`}>Subject line</label>
            <input
              className="text-input" id={`subject-${template.id}`} value={subject}
              onChange={(e) => setSubject(e.target.value)} disabled={busy}
            />
          </div>

          <div className={styles.field}>
            <label className="field-label" htmlFor={`body-${template.id}`}>Message</label>
            <textarea
              className="text-input" id={`body-${template.id}`} value={htmlBody} rows={8}
              onChange={(e) => setHtmlBody(e.target.value)} disabled={busy}
            />
            <p className={styles.hintText}>
              Basic formatting only — paragraphs, bold, lists and links. Anything else is removed before sending.
            </p>
          </div>

          <div className={styles.field}>
            <span className="field-label">Fill-in-the-blanks you can use</span>
            <div className={styles.row}>
              {TEMPLATE_VARIABLES.map((variable) => (
                <button
                  className="ghost-button" type="button" key={variable.key} disabled={busy}
                  title={`Inserts ${variable.label.toLowerCase()}, e.g. ${variable.sample}`}
                  onClick={() => setHtmlBody((current) => `${current}{{${variable.key}}}`)}
                >
                  {variable.label}
                </button>
              ))}
            </div>
            {unknown.length > 0 ? (
              <p className={styles.hintText}>
                {unknown.map((name) => `{{${name}}}`).join(", ")} will appear empty — nothing fills those in.
              </p>
            ) : null}
          </div>

          <div className={styles.field}>
            <span className="field-label">How it will look</span>
            <p className={styles.hintText}>Shown with example details for one speaker.</p>
            <div className={styles.templatePreview}>
              <strong>{preview.subject}</strong>
              {/* Sanitized by previewTemplate with the same allowlist the server applies. */}
              <div dangerouslySetInnerHTML={{ __html: preview.html }} />
            </div>
          </div>

          <div className={styles.actions}>
            <button className="primary-button" type="button" onClick={save} disabled={busy || !dirty}>
              <Check size={15} aria-hidden="true" /> {busy ? "Saving…" : "Save wording"}
            </button>
            {dirty ? (
              <button className="ghost-button" type="button" onClick={reset} disabled={busy}>
                <RotateCcw size={15} aria-hidden="true" /> Undo changes
              </button>
            ) : null}
          </div>

          {saved ? (
            <div className={`${styles.result} ${saved.tone === "good" ? styles.resultGood : saved.tone === "bad" ? styles.resultBad : styles.resultWarn}`} role="status">
              <span className={styles.resultHead}>{saved.headline}</span>
              {saved.note ? <p className={styles.resultAdvice}>{saved.note}</p> : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
