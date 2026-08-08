"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { describeReminderResult, type IntegrationStatus } from "@/lib/operations/status";
import styles from "./operations.module.css";

type Speaker = { userId: string; name: string; email: string };
type Template = { key: string; subject: string };
type Result = { tone: "good" | "warn" | "bad"; headline: string; note?: string };

/**
 * Trigger `POST /api/comms/reminders`.
 *
 * Recipient choice is explicit: "everyone who still has something outstanding"
 * is the default because that is the operator's actual intent, and the server
 * decides eligibility either way (this panel cannot widen it).
 */
export function RemindersPanel({
  eventId,
  templates,
  speakers,
  email,
}: {
  eventId: string;
  templates: Template[];
  speakers: Speaker[];
  email: IntegrationStatus;
}) {
  const [templateKey, setTemplateKey] = useState(templates[0]?.key ?? "");
  const [mode, setMode] = useState<"all" | "selected">("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [includeCalendarInvite, setIncludeCalendarInvite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  function toggle(userId: string) {
    setSelected((current) =>
      current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId],
    );
  }

  async function send() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/comms/reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId,
          templateKey,
          includeCalendarInvite,
          ...(mode === "selected" ? { recipientUserIds: selected } : {}),
        }),
      });
      const body = await res.json();
      if (!body?.ok) {
        setResult({ tone: "bad", headline: body?.error?.message ?? "The reminders could not be sent." });
        return;
      }
      const described = describeReminderResult(body.data);
      setResult({
        tone: described.tone,
        headline: described.headline,
        note: body.data.mocked
          ? "Turn on a mail provider for this deployment to send for real."
          : undefined,
      });
    } catch {
      setResult({ tone: "bad", headline: "We couldn't reach the server. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  const canSend = templateKey !== "" && !busy && (mode === "all" || selected.length > 0);

  return (
    <section className={styles.panel} aria-labelledby="ops-reminders">
      <div className={styles.panelHead}>
        <h2 id="ops-reminders">Speaker reminders</h2>
        <p>Email the speakers who still have onboarding to finish.</p>
      </div>

      <p className={styles.hintText}>
        <span className={`pill ${email.tone === "live" ? "good" : "warn"}`}>{email.label}</span> {email.detail}
      </p>

      {templates.length === 0 ? (
        <p className={styles.empty}>No email templates exist for this event yet.</p>
      ) : (
        <>
          <div className={styles.field}>
            <label className="field-label" htmlFor="ops-template">Message</label>
            <select className="text-input" id="ops-template" value={templateKey} onChange={(e) => setTemplateKey(e.target.value)}>
              {templates.map((template) => (
                <option key={template.key} value={template.key}>{template.subject}</option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <span className="field-label">Who gets it</span>
            <div className={styles.row}>
              <label className={styles.recipient}>
                <input type="radio" name="ops-recipients" checked={mode === "all"} onChange={() => setMode("all")} />
                Everyone with outstanding tasks
              </label>
              <label className={styles.recipient}>
                <input type="radio" name="ops-recipients" checked={mode === "selected"} onChange={() => setMode("selected")} />
                Pick speakers
              </label>
            </div>
          </div>

          {mode === "selected" ? (
            speakers.length === 0 ? (
              <p className={styles.empty}>No speakers are on a confirmed session yet.</p>
            ) : (
              <div className={styles.recipientList} role="group" aria-label="Choose speakers">
                {speakers.map((speaker) => (
                  <label className={styles.recipient} key={speaker.userId}>
                    <input type="checkbox" checked={selected.includes(speaker.userId)} onChange={() => toggle(speaker.userId)} />
                    {speaker.name} <span className="muted">{speaker.email}</span>
                  </label>
                ))}
              </div>
            )
          ) : null}

          <label className={styles.recipient}>
            <input type="checkbox" checked={includeCalendarInvite} onChange={(e) => setIncludeCalendarInvite(e.target.checked)} />
            Attach a calendar invite for their session
          </label>

          <div className={styles.actions}>
            <button className="primary-button" type="button" onClick={send} disabled={!canSend}>
              <Send size={15} aria-hidden="true" /> {busy ? "Sending…" : "Send reminders"}
            </button>
            {mode === "selected" ? <span className="muted">{selected.length} selected</span> : null}
          </div>
        </>
      )}

      {result ? (
        <div className={`${styles.result} ${result.tone === "good" ? styles.resultGood : result.tone === "bad" ? styles.resultBad : styles.resultWarn}`} role="status">
          <span className={styles.resultHead}>{result.headline}</span>
          {result.note ? <p className={styles.resultAdvice}>{result.note}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
