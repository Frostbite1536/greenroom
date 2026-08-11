export const AIRTABLE_TABLES = ["Sessions", "Speakers", "Schedule"] as const;

export type AirtableTable = (typeof AIRTABLE_TABLES)[number];
export type AirtableFieldValue = string | number | boolean;
export type AirtableRecord = { fields: Record<string, AirtableFieldValue> };

export type MirrorEvent = { id: string; name: string };

export type MirrorSession = {
  id: string;
  sourceAbstractId: string | null;
  sourceAbstractStatus: string | null;
  /** The organizer's publish decision. Same column every public read filters on. */
  contentStatus: "DRAFT" | "PUBLISHED";
  title: string;
  description: string | null;
  format: string | null;
  durationMinutes: number;
  speakers: Array<{
    user: {
      id: string;
      name: string;
      email: string;
      profile: { bio: string | null; company: string | null; jobTitle: string | null } | null;
    };
  }>;
  scheduleSlot: {
    id: string;
    startsAt: Date;
    endsAt: Date;
    roomName: string;
    trackName: string | null;
  } | null;
};

export type AirtableProjection = { tables: Record<AirtableTable, AirtableRecord[]> };

export type AirtableMirrorMode = "preview" | "noop" | "live";

/** Decide before any network operation whether a mirror is permitted to write. */
export function resolveAirtableMirrorMode(input: {
  dryRun: boolean;
  mockExternalApis: boolean;
  apiKey?: string;
  baseId?: string;
}): { mode: AirtableMirrorMode; reason?: string } {
  if (input.dryRun) return { mode: "preview", reason: "dry_run" };
  if (!input.apiKey || !input.baseId) return { mode: "noop", reason: "missing_airtable_configuration" };
  if (input.mockExternalApis) return { mode: "noop", reason: "mock_external_apis_enabled" };
  return { mode: "live" };
}

function value(value: string | null | undefined): string {
  return value ?? "";
}

function iso(value: Date | null | undefined): string {
  return value ? value.toISOString() : "";
}

/** On the programme by acceptance: guaranteed sessions have no source abstract. */
function isProgramSession(session: MirrorSession): boolean {
  return !session.sourceAbstractId || session.sourceAbstractStatus === "ACCEPTED";
}

/**
 * On the programme *publicly* (GRA2-02).
 *
 * `contentStatus` is the organizer's publish decision, and every public read —
 * the programme, the calendar feed, the speaker directory, `/api/v1/schedule` —
 * has filtered on `PUBLISHED` since the Tier-3 bundle. This projection did not,
 * so a talk withheld from the public site, and its speakers' names, bios and
 * email addresses, were still exported live to a third-party base. A mirror is
 * a publication; it cannot be laxer than the pages it mirrors.
 */
function isMirrorableSession(session: MirrorSession): boolean {
  return isProgramSession(session) && session.contentStatus === "PUBLISHED";
}

/**
 * Sessions held back *solely* because they are unpublished — accepted or
 * guaranteed, and would ship the moment an organizer publishes them.
 *
 * Deliberately not "every unpublished row": a rejected proposal is not
 * something an operator can act on, and counting it would turn a checklist into
 * noise. Disclosed on the preview so a silent difference between what an
 * operator sees here and what lands in Airtable is impossible.
 */
export function countUnpublishedExclusions(sessions: readonly MirrorSession[]): number {
  return sessions.filter(
    (session) => isProgramSession(session) && session.contentStatus !== "PUBLISHED",
  ).length;
}

/**
 * Project Greenroom's confirmed program into the documented, flat Airtable
 * tables. The stable External ID is the merge key used for Airtable upserts.
 */
export function buildAirtableProjection(event: MirrorEvent, sourceSessions: MirrorSession[]): AirtableProjection {
  const sessions = sourceSessions.filter(isMirrorableSession);
  const speakerById = new Map<string, AirtableRecord>();

  const sessionRecords = sessions.map((session) => {
    const slot = session.scheduleSlot;
    const speakers = session.speakers.map(({ user }) => user);
    for (const speaker of speakers) {
      if (!speakerById.has(speaker.id)) {
        speakerById.set(speaker.id, {
          fields: {
            "External ID": `speaker:${speaker.id}`,
            "Event ID": event.id,
            Event: event.name,
            Name: speaker.name,
            Email: speaker.email,
            Company: value(speaker.profile?.company),
            "Job Title": value(speaker.profile?.jobTitle),
            Bio: value(speaker.profile?.bio),
          },
        });
      }
    }

    return {
      fields: {
        "External ID": `session:${session.id}`,
        "Event ID": event.id,
        Event: event.name,
        Title: session.title,
        Description: value(session.description),
        Format: value(session.format),
        "Duration Minutes": session.durationMinutes,
        "Speaker IDs": speakers.map((speaker) => `speaker:${speaker.id}`).join(", "),
        "Speaker Emails": speakers.map((speaker) => speaker.email).join(", "),
        "Scheduled Start": iso(slot?.startsAt),
        "Scheduled End": iso(slot?.endsAt),
        Room: value(slot?.roomName),
        Track: value(slot?.trackName),
      },
    };
  });

  const scheduleRecords = sessions
    .filter((session): session is MirrorSession & { scheduleSlot: NonNullable<MirrorSession["scheduleSlot"]> } => Boolean(session.scheduleSlot))
    .map((session) => ({
      fields: {
        "External ID": `slot:${session.scheduleSlot.id}`,
        "Event ID": event.id,
        Event: event.name,
        "Session ID": `session:${session.id}`,
        "Session Title": session.title,
        "Starts At": session.scheduleSlot.startsAt.toISOString(),
        "Ends At": session.scheduleSlot.endsAt.toISOString(),
        Room: session.scheduleSlot.roomName,
        Track: value(session.scheduleSlot.trackName),
      },
    }));

  return {
    tables: {
      Sessions: sessionRecords,
      Speakers: [...speakerById.values()].sort((a, b) => String(a.fields.Email).localeCompare(String(b.fields.Email))),
      Schedule: scheduleRecords.sort((a, b) => String(a.fields["Starts At"]).localeCompare(String(b.fields["Starts At"]))),
    },
  };
}

export function projectionCounts(projection: AirtableProjection): Record<AirtableTable, number> {
  return Object.fromEntries(AIRTABLE_TABLES.map((table) => [table, projection.tables[table].length])) as Record<AirtableTable, number>;
}

export type AirtableFetch = typeof fetch;
export type AirtableConfig = { apiKey: string; baseId: string };

/** Airtable's REST API accepts at most 10 upsert records per request. */
export const AIRTABLE_BATCH_SIZE = 10;
/** Keep an operator-readable failure list without unbounded response growth. */
export const AIRTABLE_MAX_REPORTED_FAILURES = 50;

/** Transient conditions: worth one bounded retry of the same request. */
const RETRYABLE_STATUSES = new Set([0, 408, 429, 500, 502, 503, 504]);
/**
 * Credential/table-level faults. Splitting the batch into single-record writes
 * cannot help, so the mirror stops that table instead of amplifying requests.
 */
const FATAL_TABLE_STATUSES = new Set([401, 403, 404]);

export type AirtableRecordFailure = { externalId: string; status: number; message: string };

export type AirtableTableReport = {
  table: AirtableTable;
  attempted: number;
  upserted: number;
  failed: number;
  /** HTTP requests actually issued, including retries and per-record recovery. */
  requests: number;
  failures: AirtableRecordFailure[];
  failuresTruncated: boolean;
};

export type AirtableMirrorReport = {
  status: "complete" | "partial" | "failed";
  attempted: number;
  upserted: number;
  failed: number;
  requests: number;
  tables: AirtableTableReport[];
};

export type AirtableMirrorOptions = {
  /** Attempts per request before giving up on a retryable status. */
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

type ResolvedOptions = Required<AirtableMirrorOptions>;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function resolveOptions(options: AirtableMirrorOptions): ResolvedOptions {
  return {
    maxAttempts: options.maxAttempts ?? 3,
    retryDelayMs: options.retryDelayMs ?? 250,
    sleep: options.sleep ?? defaultSleep,
    timeoutMs: options.timeoutMs ?? 10_000,
  };
}

function chunks<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_value, index) => items.slice(index * size, (index + 1) * size));
}

function externalIdOf(record: AirtableRecord): string {
  const id = record.fields["External ID"];
  return typeof id === "string" && id.length > 0 ? id : "(unknown)";
}

function truncate(text: string, max = 240): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Airtable errors are `{ error: { type, message } }`; never echo request data. */
async function describeFailure(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (!text) return `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: { type?: string; message?: string } | string };
      const error = parsed.error;
      if (typeof error === "string") return truncate(error);
      if (error?.type || error?.message) return truncate([error.type, error.message].filter(Boolean).join(": "));
    } catch {
      // Non-JSON body (proxy/HTML error page): fall through to the raw text.
    }
    return truncate(text);
  } catch {
    return `HTTP ${response.status}`;
  }
}

type UpsertOutcome = { ok: true } | { ok: false; status: number; message: string };

async function sendUpsert(
  fetcher: AirtableFetch,
  config: AirtableConfig,
  table: AirtableTable,
  records: AirtableRecord[],
  options: ResolvedOptions,
): Promise<UpsertOutcome> {
  try {
    const response = await fetcher(`https://api.airtable.com/v0/${encodeURIComponent(config.baseId)}/${encodeURIComponent(table)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs),
      body: JSON.stringify({
        records,
        typecast: true,
        performUpsert: { fieldsToMergeOn: ["External ID"] },
      }),
    });
    if (response.ok) return { ok: true };
    return { ok: false, status: response.status, message: await describeFailure(response) };
  } catch (error) {
    // Network fault/timeout: status 0 keeps the report shape uniform.
    return { ok: false, status: 0, message: truncate(error instanceof Error ? error.message : "Network request failed.") };
  }
}

async function sendWithRetry(
  fetcher: AirtableFetch,
  config: AirtableConfig,
  table: AirtableTable,
  records: AirtableRecord[],
  options: ResolvedOptions,
): Promise<{ outcome: UpsertOutcome; requests: number }> {
  let requests = 0;
  let outcome = await sendUpsert(fetcher, config, table, records, options);
  requests++;
  for (let attempt = 1; attempt < options.maxAttempts && !outcome.ok && RETRYABLE_STATUSES.has(outcome.status); attempt++) {
    await options.sleep(options.retryDelayMs * attempt);
    outcome = await sendUpsert(fetcher, config, table, records, options);
    requests++;
  }
  return { outcome, requests };
}

/**
 * Upsert one table with partial-write recovery.
 *
 * A rejected batch is retried one record at a time, so a single unmappable row
 * can never discard the nine valid rows shipped alongside it. Every skipped row
 * is reported with its External ID and Airtable's own reason. Because the writes
 * upsert on External ID, re-running the mirror is the resume path: rows that
 * already landed are rewritten identically and previously failed rows are
 * retried, with no duplicates and no deletes.
 */
export async function mirrorAirtableTable(
  fetcher: AirtableFetch,
  config: AirtableConfig,
  table: AirtableTable,
  records: AirtableRecord[],
  options: AirtableMirrorOptions = {},
): Promise<AirtableTableReport> {
  const resolved = resolveOptions(options);
  const report: AirtableTableReport = {
    table,
    attempted: records.length,
    upserted: 0,
    failed: 0,
    requests: 0,
    failures: [],
    failuresTruncated: false,
  };

  const recordFailure = (record: AirtableRecord, status: number, message: string) => {
    report.failed++;
    if (report.failures.length < AIRTABLE_MAX_REPORTED_FAILURES) {
      report.failures.push({ externalId: externalIdOf(record), status, message });
    } else {
      report.failuresTruncated = true;
    }
  };

  const batches = chunks(records, AIRTABLE_BATCH_SIZE);
  let fatal = false;
  for (const [index, batch] of batches.entries()) {
    const batchResult = await sendWithRetry(fetcher, config, table, batch, resolved);
    report.requests += batchResult.requests;
    if (batchResult.outcome.ok) {
      report.upserted += batch.length;
      continue;
    }

    const { status, message } = batchResult.outcome;
    if (FATAL_TABLE_STATUSES.has(status)) {
      for (const record of batches.slice(index).flat()) recordFailure(record, status, message);
      break;
    }

    for (const [recordIndex, record] of batch.entries()) {
      const single = await sendWithRetry(fetcher, config, table, [record], resolved);
      report.requests += single.requests;
      if (single.outcome.ok) {
        report.upserted++;
        continue;
      }
      recordFailure(record, single.outcome.status, single.outcome.message);
      // A credential/table fault reported mid-recovery is just as fatal as one
      // reported for a whole batch: stop this table instead of issuing one
      // doomed request per remaining record.
      if (FATAL_TABLE_STATUSES.has(single.outcome.status)) {
        const remaining = [...batch.slice(recordIndex + 1), ...batches.slice(index + 1).flat()];
        for (const rest of remaining) recordFailure(rest, single.outcome.status, single.outcome.message);
        fatal = true;
        break;
      }
    }
    if (fatal) break;
  }

  return report;
}

/**
 * Mirror every projected table. A failing table never aborts the others: the
 * three tables are independent flat projections, so an operator gets as much of
 * the program into Airtable as the base will accept, plus an exact repair list.
 */
export async function mirrorAirtableTables(
  fetcher: AirtableFetch,
  config: AirtableConfig,
  projection: AirtableProjection,
  options: AirtableMirrorOptions = {},
): Promise<AirtableMirrorReport> {
  const tables: AirtableTableReport[] = [];
  for (const table of AIRTABLE_TABLES) {
    tables.push(await mirrorAirtableTable(fetcher, config, table, projection.tables[table], options));
  }

  const attempted = tables.reduce((total, table) => total + table.attempted, 0);
  const upserted = tables.reduce((total, table) => total + table.upserted, 0);
  const failed = tables.reduce((total, table) => total + table.failed, 0);
  const requests = tables.reduce((total, table) => total + table.requests, 0);
  const status: AirtableMirrorReport["status"] =
    failed === 0 ? "complete" : upserted === 0 ? "failed" : "partial";

  return { status, attempted, upserted, failed, requests, tables };
}

/** One-line operator summary, safe to log and to return in an error message. */
export function summarizeMirrorReport(report: AirtableMirrorReport): string {
  const first = report.tables.flatMap((table) => table.failures.map((failure) => `${table.table}/${failure.externalId}: ${failure.status} ${failure.message}`))[0];
  const base = `${report.upserted}/${report.attempted} records upserted, ${report.failed} failed`;
  return first ? `${base} (first failure — ${first})` : base;
}
