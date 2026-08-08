/**
 * Plain-language status for the operations console.
 *
 * The people running an event are not engineers: every string here is what an
 * operator reads before deciding whether to press a button that talks to a
 * third party. Nothing in this module can reveal a credential — callers pass
 * booleans describing whether a key is present, never the key.
 */
export type IntegrationTone = "live" | "mock" | "unconfigured";

export type IntegrationStatus = {
  tone: IntegrationTone;
  label: string;
  /** What pressing the button will actually do, in one sentence. */
  detail: string;
  /** False when a run would be a no-op, so the UI can say so up front. */
  writesExternally: boolean;
};

/**
 * Mirrors `resolveAirtableMirrorMode` / `resolveAcceleventsPushMode`: demo mode
 * wins over credentials, and missing credentials fall back to a no-op rather
 * than an error. Kept in sync deliberately so the UI never promises a write the
 * server will refuse.
 */
export function integrationStatus(input: {
  name: string;
  mocked: boolean;
  configured: boolean;
  /** What the integration does when it is live, e.g. "copy the programme to Airtable". */
  action: string;
}): IntegrationStatus {
  if (!input.configured) {
    return {
      tone: "unconfigured",
      label: "Not connected",
      detail: `${input.name} has no credentials on this deployment, so a run is recorded but nothing leaves Greenroom.`,
      writesExternally: false,
    };
  }
  if (input.mocked) {
    return {
      tone: "mock",
      label: "Demo mode",
      detail: `This deployment runs integrations in demo mode. A run is logged and safe, but it will not ${input.action}.`,
      writesExternally: false,
    };
  }
  return {
    tone: "live",
    label: "Connected",
    detail: `A run will ${input.action} for real.`,
    writesExternally: true,
  };
}

export type MirrorTableReport = {
  table: string;
  attempted: number;
  upserted: number;
  failed: number;
  failures: { externalId: string; status: number; message: string }[];
  failuresTruncated?: boolean;
};

export type MirrorReport = {
  status: "complete" | "partial" | "failed";
  attempted: number;
  upserted: number;
  failed: number;
  tables: MirrorTableReport[];
};

/** One sentence an operator can act on, plus the tone for the result panel. */
export function describeMirrorReport(report: MirrorReport): { tone: "good" | "warn" | "bad"; headline: string; advice: string } {
  if (report.status === "complete") {
    return {
      tone: "good",
      headline: `All ${report.upserted} records are up to date in Airtable.`,
      advice: "Running this again is safe — it updates the same rows instead of creating duplicates.",
    };
  }
  if (report.status === "partial") {
    return {
      tone: "warn",
      headline: `${report.upserted} of ${report.attempted} records copied; ${report.failed} could not be saved.`,
      advice: "The rows below were skipped. Fix them in Airtable, then run this again — the rows that worked stay as they are.",
    };
  }
  return {
    tone: "bad",
    headline: "Nothing was copied to Airtable.",
    advice: "This usually means the connection details are wrong. Nothing was half-written, so it is safe to run again once they are fixed.",
  };
}

export function describeReminderResult(result: { recipientCount: number; sent: number; failed: number; mocked: boolean }): {
  tone: "good" | "warn" | "bad";
  headline: string;
} {
  if (result.recipientCount === 0) {
    return { tone: "warn", headline: "Nobody matched — there was no one to email." };
  }
  const who = `${result.sent} of ${result.recipientCount} speaker${result.recipientCount === 1 ? "" : "s"}`;
  if (result.mocked) {
    return { tone: "warn", headline: `Demo mode: ${who} would have been emailed. Nothing was actually sent.` };
  }
  if (result.failed > 0) {
    return { tone: "warn", headline: `${who} emailed. ${result.failed} could not be delivered.` };
  }
  return { tone: "good", headline: `${who} emailed.` };
}

export function describeImportSummary(summary: { rows: number; created: number; updated: number; skipped: number }): string {
  const parts = [`${summary.rows} row${summary.rows === 1 ? "" : "s"} read`];
  if (summary.created) parts.push(`${summary.created} added`);
  if (summary.updated) parts.push(`${summary.updated} updated`);
  if (summary.skipped) parts.push(`${summary.skipped} already up to date`);
  return `${parts.join(" · ")}.`;
}

/**
 * Import failures arrive as `Row 4: title is required.` The row number is the
 * only thing an operator needs to fix their spreadsheet, so surface it.
 */
export function describeImportError(message: string): { row: number | null; text: string } {
  const match = message.match(/^Row (\d+):\s*(.+)$/);
  if (!match) return { row: null, text: message };
  return { row: Number(match[1]), text: match[2] };
}

/** Column names the abstract importer understands, for the mapping form. */
export const IMPORT_TARGETS: { value: string; label: string; required: boolean; hint?: string }[] = [
  { value: "title", label: "Talk title", required: true },
  { value: "speakerEmail", label: "Speaker email", required: true },
  { value: "speakerName", label: "Speaker name", required: true },
  { value: "formConfigId", label: "Form", required: true, hint: "Which CFP form these proposals belong to." },
  { value: "abstract", label: "Description", required: false },
  { value: "format", label: "Session type", required: false },
  { value: "durationMinutes", label: "Length in minutes", required: false },
  { value: "category", label: "Track", required: false, hint: "Matched by track name." },
];
