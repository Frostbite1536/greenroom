"use client";

import { useState } from "react";
import { RefreshCw, Upload } from "lucide-react";
import {
  describeMirrorReport,
  type IntegrationStatus,
  type MirrorReport,
} from "@/lib/operations/status";
import styles from "./operations.module.css";

type Panel = { tone: "good" | "warn" | "bad"; headline: string; advice?: string; report?: MirrorReport };

/**
 * Trigger the two one-way integrations.
 *
 * Both APIs default to `dryRun: true`, and this panel keeps that default in the
 * UI: "Check first" is the primary action, and the real run is a separate,
 * explicitly-labelled button. When the deployment cannot write externally the
 * live button is disabled with the reason shown, rather than failing after the
 * click.
 */
export function IntegrationsPanel({
  eventId,
  airtable,
  accelevents,
}: {
  eventId: string;
  airtable: IntegrationStatus;
  accelevents: IntegrationStatus;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [mirror, setMirror] = useState<Panel | null>(null);
  const [push, setPush] = useState<Panel | null>(null);

  async function run(path: string, dryRun: boolean, set: (panel: Panel) => void, key: string) {
    setBusy(key);
    set({ tone: "warn", headline: dryRun ? "Checking…" : "Running…" });
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, dryRun }),
      });
      const body = await res.json();
      if (!body?.ok) {
        set({ tone: "bad", headline: body?.error?.message ?? "That did not complete.", advice: "Nothing was left half-written — it is safe to try again." });
        return;
      }
      const data = body.data;
      // GRA2-02: both integrations now export published sessions only, so the
      // number they send can be smaller than the programme on screen. Say why,
      // in its own sentence — a count buried in the JSON is not a disclosure.
      const withheld = typeof data.excluded?.unpublishedSessions === "number"
        ? data.excluded.unpublishedSessions
        : 0;
      const withheldNote = withheld > 0
        ? `${withheld} unpublished ${withheld === 1 ? "session is" : "sessions are"} held back — publish ${withheld === 1 ? "it" : "them"} to include ${withheld === 1 ? "it" : "them"}.`
        : undefined;

      if (data.report) {
        const described = describeMirrorReport(data.report as MirrorReport);
        set({
          ...described,
          advice: [described.advice, withheldNote].filter(Boolean).join(" ") || undefined,
          report: data.report as MirrorReport,
        });
        return;
      }
      const counts = data.counts ?? data.summary ?? {};
      const totals = Object.entries(counts)
        .filter(([, value]) => typeof value === "number")
        .map(([name, value]) => `${value} ${name.toLowerCase()}`)
        .join(", ");
      set({
        tone: "good",
        headline: dryRun
          ? `Ready to send${totals ? `: ${totals}` : ""}.`
          : data.mode === "live"
            ? `Sent${totals ? `: ${totals}` : ""}.`
            : `Nothing was sent${totals ? ` — ${totals} were prepared` : ""}.`,
        advice: [
          data.mode === "noop" ? "This deployment is not connected to that service, so the run was recorded but nothing left Greenroom." : undefined,
          withheldNote,
        ].filter(Boolean).join(" ") || undefined,
      });
    } catch {
      set({ tone: "bad", headline: "We couldn't reach the server. Check your connection and try again." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="ops-integrations">
      <div className={styles.panelHead}>
        <h2 id="ops-integrations">Keep other tools in step</h2>
        <p>Send the confirmed programme out to the tools your team already uses. Nothing is ever deleted at the other end.</p>
      </div>

      <Integration
        title="Airtable"
        description="Copies sessions, speakers and the schedule into your base. Rows are matched on their ID, so running it twice updates instead of duplicating."
        status={airtable}
        busy={busy === "airtable-check" || busy === "airtable-run"}
        onCheck={() => run("/api/comms/airtable/mirror", true, setMirror, "airtable-check")}
        onRun={() => run("/api/comms/airtable/mirror", false, setMirror, "airtable-run")}
        runLabel="Copy to Airtable"
        panel={mirror}
      />

      <Integration
        title="Accelevents"
        description="Sends the confirmed programme to your configured Accelevents endpoint."
        status={accelevents}
        busy={busy === "accelevents-check" || busy === "accelevents-run"}
        onCheck={() => run("/api/integrations/accelevents/push", true, setPush, "accelevents-check")}
        onRun={() => run("/api/integrations/accelevents/push", false, setPush, "accelevents-run")}
        runLabel="Send to Accelevents"
        panel={push}
      />
    </section>
  );
}

function Integration({
  title,
  description,
  status,
  busy,
  onCheck,
  onRun,
  runLabel,
  panel,
}: {
  title: string;
  description: string;
  status: IntegrationStatus;
  busy: boolean;
  onCheck: () => void;
  onRun: () => void;
  runLabel: string;
  panel: Panel | null;
}) {
  return (
    <div className={styles.field}>
      <div className="row wrap">
        <strong>{title}</strong>
        <span className={`pill ${status.tone === "live" ? "good" : status.tone === "mock" ? "warn" : "neutral"}`}>{status.label}</span>
      </div>
      <p className={styles.hintText}>{description}</p>
      <p className={styles.hintText}>{status.detail}</p>
      <div className={styles.actions}>
        <button className="ghost-button" type="button" onClick={onCheck} disabled={busy}>
          <RefreshCw size={15} aria-hidden="true" /> Check first
        </button>
        <button
          className="primary-button"
          type="button"
          onClick={onRun}
          disabled={busy || !status.writesExternally}
          title={status.writesExternally ? undefined : status.detail}
        >
          <Upload size={15} aria-hidden="true" /> {runLabel}
        </button>
      </div>
      {panel ? <ResultPanel panel={panel} /> : null}
    </div>
  );
}

function ResultPanel({ panel }: { panel: Panel }) {
  const tone = panel.tone === "good" ? styles.resultGood : panel.tone === "bad" ? styles.resultBad : styles.resultWarn;
  const failures = (panel.report?.tables ?? []).flatMap((table) =>
    table.failures.map((failure) => ({ table: table.table, ...failure })),
  );
  return (
    <div className={`${styles.result} ${tone}`} role="status">
      <span className={styles.resultHead}>{panel.headline}</span>
      {panel.advice ? <p className={styles.resultAdvice}>{panel.advice}</p> : null}
      {failures.length > 0 ? (
        <ul className={styles.failureList}>
          {failures.map((failure) => (
            <li key={`${failure.table}-${failure.externalId}`}>
              <span className={styles.failureId}>{failure.table} · {failure.externalId}</span> — {failure.message}
            </li>
          ))}
        </ul>
      ) : null}
      {panel.report?.tables.some((table) => table.failuresTruncated) ? (
        <p className={styles.resultAdvice}>Only the first 50 problems per table are listed.</p>
      ) : null}
    </div>
  );
}
