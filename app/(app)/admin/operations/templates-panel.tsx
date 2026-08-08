"use client";

import { useState } from "react";
import { Mail } from "lucide-react";
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

/**
 * The wording behind each reminder, so an operator can read exactly what a
 * speaker will receive before pressing Send.
 *
 * Read-only by design for now: `GET /api/comms/templates` is the only template
 * endpoint that exists, and inventing a write path days before the freeze would
 * ship an untested mutation on the surface most likely to be demoed. The panel
 * says so rather than hiding it.
 */
export function TemplatesPanel({ templates }: { templates: Template[] }) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <section className={styles.panel} aria-labelledby="ops-templates">
      <div className={styles.panelHead}>
        <h2 id="ops-templates">What your speakers receive</h2>
        <p>The wording used by each reminder. Preview one before you send it.</p>
      </div>

      {templates.length === 0 ? (
        <p className={styles.empty}>No email templates exist for this event yet.</p>
      ) : (
        templates.map((template) => {
          const open = openId === template.id;
          return (
            <div className={styles.templateItem} key={template.id}>
              <div className="row wrap">
                <Mail size={15} aria-hidden="true" />
                <strong>{template.subject}</strong>
                {template.trigger ? <span className="pill neutral">{template.trigger.replace(/_/g, " ").toLowerCase()}</span> : null}
              </div>
              <span className={styles.templateKey}>Used by reminders as “{template.key}”</span>
              <div className={styles.actions}>
                <button
                  className="ghost-button"
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpenId(open ? null : template.id)}
                >
                  {open ? "Hide preview" : "Preview"}
                </button>
              </div>
              {open ? (
                <div
                  className={styles.templatePreview}
                  // Server-sanitized through lib/sanitize-html (INV-HTML-001).
                  dangerouslySetInnerHTML={{ __html: template.htmlBody }}
                />
              ) : null}
            </div>
          );
        })
      )}

      <p className={styles.hintText}>
        Wording is set up with your programme data; contact your Greenroom administrator to change it.
      </p>
    </section>
  );
}
