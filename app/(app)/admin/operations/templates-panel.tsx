"use client";

import { useMemo, useState } from "react";
import { Check, Lock, Mail, RotateCcw } from "lucide-react";
import { previewTemplate, TEMPLATE_VARIABLES, unknownTemplateVariables } from "@/lib/comms/template-edit";
import { fixedTemplatePreview, templateDelivery } from "@/lib/comms/template-truth";
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
 * Read the wording each email uses — and edit it where editing is real.
 *
 * The audit4#30 defect this panel used to embody: every template was presented
 * as editable and the preview showed the stored text, but the submission
 * receipt and both decision emails were rendered by fixed code. An operator
 * could rewrite an acceptance email, watch their words appear in the preview,
 * and the speaker would receive something else.
 *
 * Now each template renders according to `templateDelivery(key)`:
 * editable templates keep the live editor (their stored body genuinely drives
 * the send through the escaped variable engine), and code-built templates are
 * shown read-only with the *real* message — produced by the same builder the
 * send path calls, so the preview cannot drift from what is delivered. The
 * server refuses an edit to a read-only template regardless of what this
 * component renders.
 */
export function TemplatesPanel({ templates: initial }: { templates: Template[] }) {
  const [templates, setTemplates] = useState(initial);
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <section className={styles.panel} aria-labelledby="ops-templates">
      <div className={styles.panelHead}>
        <h2 id="ops-templates">What your speakers receive</h2>
        <p>
          The exact wording of each email this event sends. Most are yours to edit; a few are built by
          Greenroom and shown here read-only, so what you preview is always what gets delivered.
        </p>
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
  const delivery = useMemo(() => templateDelivery(template.key), [template.key]);
  // Non-null exactly when `delivery.editable` is false — the real fixed message.
  const sentMessage = useMemo(() => fixedTemplatePreview(template.key), [template.key]);

  const [subject, setSubject] = useState(template.subject);
  const [htmlBody, setHtmlBody] = useState(template.htmlBody);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Saved | null>(null);

  const preview = useMemo(() => previewTemplate({ subject, htmlBody }), [subject, htmlBody]);
  const unknown = useMemo(() => unknownTemplateVariables(subject, htmlBody), [subject, htmlBody]);
  const dirty = subject !== template.subject || htmlBody !== template.htmlBody;

  // The stored subject of a read-only template is decoration; the delivered
  // subject comes from the builder. Never show the one that will not be sent.
  const headlineSubject = sentMessage ? sentMessage.subject : template.subject;

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
        // Names the real trigger rather than claiming "reminders": this template
        // may be the automatic submission receipt, which no operator triggers.
        headline: `Saved. ${delivery.summary}`,
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
        <strong>{headlineSubject}</strong>
        {template.trigger ? <span className="pill neutral">{template.trigger.replace(/_/g, " ").toLowerCase()}</span> : null}
        {delivery.editable ? null : (
          <span className="pill info">
            <Lock size={12} aria-hidden="true" /> Read-only
          </span>
        )}
      </div>
      <span className={styles.templateKey}>
        Template key “{template.key}” · {delivery.summary}
      </span>
      <div className={styles.actions}>
        <button className="ghost-button" type="button" aria-expanded={open} onClick={onToggle}>
          {open ? "Close" : delivery.editable ? "Edit and preview" : "See what is sent"}
        </button>
      </div>

      {!open ? null : sentMessage ? (
        /* Read-only: show the real message, not the stored text nothing renders. */
        <>
          <div className={styles.field}>
            <span className="field-label">Why you can&rsquo;t edit this one</span>
            <p className={styles.hintText}>{delivery.reason}</p>
          </div>

          <div className={styles.field}>
            <span className="field-label">What is actually sent</span>
            <p className={styles.hintText}>
              Shown with example details for one speaker. This is built by the same code that sends the
              email, so it cannot drift from the delivered message. An organizer&rsquo;s note and any
              reviewer comments you choose to include are added on top of this when you send from Decisions.
            </p>
            <div className={styles.templatePreview}>
              <strong>{sentMessage.subject}</strong>
              {/* Built by `buildDecisionEmail`, which escapes every interpolated value. */}
              <div dangerouslySetInnerHTML={{ __html: sentMessage.html }} />
            </div>
          </div>
        </>
      ) : (
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
            <p className={styles.hintText}>
              Shown with example details for one speaker. This wording is what gets sent.
            </p>
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
      )}
    </div>
  );
}
