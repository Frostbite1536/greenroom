export const AIRTABLE_TABLES = ["Sessions", "Speakers", "Schedule"] as const;

export type AirtableTable = (typeof AIRTABLE_TABLES)[number];
export type AirtableFieldValue = string | number | boolean;
export type AirtableRecord = { fields: Record<string, AirtableFieldValue> };

export type MirrorEvent = { id: string; name: string };

export type MirrorSession = {
  id: string;
  sourceAbstractId: string | null;
  sourceAbstractStatus: string | null;
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

function isMirrorableSession(session: MirrorSession): boolean {
  // A Session without a source abstract is an intentionally guaranteed session.
  return !session.sourceAbstractId || session.sourceAbstractStatus === "ACCEPTED";
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

export class AirtableMirrorError extends Error {
  constructor(readonly table: AirtableTable, readonly status: number) {
    super(`Airtable upsert failed for ${table} (${status}).`);
    this.name = "AirtableMirrorError";
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_value, index) => items.slice(index * size, (index + 1) * size));
}

/** Airtable's REST API accepts at most 10 upsert records per request. */
export async function upsertAirtableTable(
  fetcher: AirtableFetch,
  config: { apiKey: string; baseId: string },
  table: AirtableTable,
  records: AirtableRecord[],
): Promise<number> {
  let batches = 0;
  for (const batch of chunks(records, 10)) {
    const response = await fetcher(`https://api.airtable.com/v0/${encodeURIComponent(config.baseId)}/${encodeURIComponent(table)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        records: batch,
        typecast: true,
        performUpsert: { fieldsToMergeOn: ["External ID"] },
      }),
    });
    if (!response.ok) throw new AirtableMirrorError(table, response.status);
    batches++;
  }
  return batches;
}
