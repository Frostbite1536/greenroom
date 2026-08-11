"use client";

import { useState } from "react";
import { CalendarPlus } from "lucide-react";
import { describeCalendarInviteResult, type IntegrationStatus } from "@/lib/operations/status";
import styles from "./operations.module.css";

type Result = { tone: "good" | "warn" | "bad"; headline: string; note?: string };

/**
 * Trigger `POST /api/comms/calendar-invites`.
 *
 * Sits beside the reminders panel and deliberately offers no recipient picker:
 * an invitation goes to whoever is on the published schedule, which the server
 * decides. The counts below come from the same predicate the route uses, so the
 * number an operator confirms is the number the send will attempt.
 */
export function CalendarInvitesPanel({
  eventId,
  speakerCount,
  sessionCount,
  email,
}: {
  eventId: string;
  speakerCount: number;
  sessionCount: number;
  email: IntegrationStatus;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function send() {
    setBusy(true);
    setConfirming(false);
    setResult(null);
    try {
      const res = await fetch("/api/comms/calendar-invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId }),
      });
      const body = await res.json();
      if (!body?.ok) {
        setResult({ tone: "bad", headline: body?.error?.message ?? "The calendar invites could not be sent." });
        return;
      }
      const described = describeCalendarInviteResult(body.data);
      setResult({
        tone: described.tone,
        headline: described.headline,
        note: body.data.deliveryMocked
          ? "Turn on a mail provider for this deployment to send for real."
          : "Speakers accept from their own calendar. Sending again updates the same entries instead of adding new ones.",
      });
    } catch {
      setResult({ tone: "bad", headline: "We couldn't reach the server. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  const speakers = `${speakerCount} speaker${speakerCount === 1 ? "" : "s"}`;
  const sessions = `${sessionCount} session${sessionCount === 1 ? "" : "s"}`;

  return (
    <section className={styles.panel} aria-labelledby="ops-calendar-invites">
      <div className={styles.panelHead}>
        <h2 id="ops-calendar-invites">Calendar invites</h2>
        <p>
          Send every scheduled speaker an invitation that lands in their own calendar — Gmail, Outlook or iCal — with
          accept and decline, not just an attachment.
        </p>
      </div>

      <p className={styles.hintText}>
        <span className={`pill ${email.tone === "live" ? "good" : "warn"}`}>{email.label}</span> {email.detail}
      </p>

      {speakerCount === 0 ? (
        <p className={styles.empty}>
          No speaker has a published, scheduled session yet, so there is nothing to invite anyone to. Schedule and
          publish a session first.
        </p>
      ) : (
        <>
          <p className={styles.hintText}>
            {speakers} would receive one invite each, covering {sessions} in total. A speaker with several talks gets a
            single email holding all of them.
          </p>

          {confirming ? (
            <div className={styles.actions}>
              <button className="primary-button" type="button" onClick={send} disabled={busy}>
                Yes, send to {speakers}
              </button>
              <button className="ghost-button" type="button" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </button>
            </div>
          ) : (
            <div className={styles.actions}>
              <button className="primary-button" type="button" onClick={() => setConfirming(true)} disabled={busy}>
                <CalendarPlus size={15} aria-hidden="true" /> {busy ? "Sending…" : "Send calendar invites"}
              </button>
            </div>
          )}
        </>
      )}

      {result ? (
        <div
          className={`${styles.result} ${result.tone === "good" ? styles.resultGood : result.tone === "bad" ? styles.resultBad : styles.resultWarn}`}
          role="status"
        >
          <span className={styles.resultHead}>{result.headline}</span>
          {result.note ? <p className={styles.resultAdvice}>{result.note}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
