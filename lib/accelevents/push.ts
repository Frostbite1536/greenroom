export type AcceleventsEvent = { id: string; name: string; slug: string };

export type AcceleventsSourceSession = {
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

export type AcceleventsPushPayload = {
  schemaVersion: "1.0";
  operation: "program.push";
  event: { externalId: string; name: string; slug: string };
  sessions: Array<{
    externalId: string;
    title: string;
    description: string | null;
    format: string | null;
    durationMinutes: number;
    speakerExternalIds: string[];
    speakerEmails: string[];
    schedule: {
      externalId: string;
      startsAt: string;
      endsAt: string;
      room: string;
      track: string | null;
    } | null;
  }>;
  speakers: Array<{
    externalId: string;
    name: string;
    email: string;
    bio: string | null;
    company: string | null;
    jobTitle: string | null;
  }>;
};

export type AcceleventsPushMode = "preview" | "noop" | "live";

/** The configured URL is an operator-owned receiving endpoint, never a guessed vendor path. */
export function resolveAcceleventsPushMode(input: {
  dryRun: boolean;
  mockExternalApis: boolean;
  endpoint?: string;
}): { mode: AcceleventsPushMode; reason?: string } {
  if (input.dryRun) return { mode: "preview", reason: "dry_run" };
  if (!input.endpoint) return { mode: "noop", reason: "missing_accelevents_endpoint" };
  if (input.mockExternalApis) return { mode: "noop", reason: "mock_external_apis_enabled" };
  return { mode: "live" };
}

function isPushableSession(session: AcceleventsSourceSession): boolean {
  // Source-less sessions are intentionally guaranteed program items.
  return !session.sourceAbstractId || session.sourceAbstractStatus === "ACCEPTED";
}

/** Build a stable, vendor-neutral program-push envelope for the configured endpoint. */
export function buildAcceleventsPushPayload(
  event: AcceleventsEvent,
  sourceSessions: AcceleventsSourceSession[],
): AcceleventsPushPayload {
  const speakers = new Map<AcceleventsPushPayload["speakers"][number]["externalId"], AcceleventsPushPayload["speakers"][number]>();
  const sessions = sourceSessions
    .filter(isPushableSession)
    .map((session) => {
      const sessionSpeakers = session.speakers.map(({ user }) => user).sort((a, b) => a.email.localeCompare(b.email));
      for (const speaker of sessionSpeakers) {
        const externalId = `speaker:${speaker.id}`;
        if (!speakers.has(externalId)) {
          speakers.set(externalId, {
            externalId,
            name: speaker.name,
            email: speaker.email,
            bio: speaker.profile?.bio ?? null,
            company: speaker.profile?.company ?? null,
            jobTitle: speaker.profile?.jobTitle ?? null,
          });
        }
      }
      return {
        externalId: `session:${session.id}`,
        title: session.title,
        description: session.description,
        format: session.format,
        durationMinutes: session.durationMinutes,
        speakerExternalIds: sessionSpeakers.map((speaker) => `speaker:${speaker.id}`),
        speakerEmails: sessionSpeakers.map((speaker) => speaker.email),
        schedule: session.scheduleSlot ? {
          externalId: `slot:${session.scheduleSlot.id}`,
          startsAt: session.scheduleSlot.startsAt.toISOString(),
          endsAt: session.scheduleSlot.endsAt.toISOString(),
          room: session.scheduleSlot.roomName,
          track: session.scheduleSlot.trackName,
        } : null,
      };
    });

  return {
    schemaVersion: "1.0",
    operation: "program.push",
    event: { externalId: `event:${event.id}`, name: event.name, slug: event.slug },
    sessions,
    speakers: [...speakers.values()].sort((a, b) => a.email.localeCompare(b.email)),
  };
}

export function acceleventsPushSummary(payload: AcceleventsPushPayload) {
  return {
    sessions: payload.sessions.length,
    speakers: payload.speakers.length,
    scheduledSessions: payload.sessions.filter((session) => session.schedule !== null).length,
  };
}

export class AcceleventsPushError extends Error {
  constructor(readonly status: number) {
    super(`Configured Accelevents endpoint returned ${status}.`);
    this.name = "AcceleventsPushError";
  }
}

/** POST the exact operator-configured URL; an optional key is sent only in Authorization. */
export async function postAcceleventsPush(
  fetcher: typeof fetch,
  config: { endpoint: string; apiKey?: string },
  payload: AcceleventsPushPayload,
): Promise<void> {
  const response = await fetcher(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: config.apiKey } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new AcceleventsPushError(response.status);
}
