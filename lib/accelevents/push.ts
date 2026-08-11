export type AcceleventsEvent = { id: string; name: string; slug: string };

export type AcceleventsSourceSession = {
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

/** On the programme by acceptance: source-less sessions are guaranteed items. */
function isProgramSession(session: AcceleventsSourceSession): boolean {
  return !session.sourceAbstractId || session.sourceAbstractStatus === "ACCEPTED";
}

/**
 * On the programme *publicly* (GRA2-02).
 *
 * Every public read has filtered on `contentStatus: "PUBLISHED"` since the
 * Tier-3 bundle; this push did not, so an unpublished talk and its speakers'
 * contact details were shipped to the operator-configured endpoint anyway. A
 * push is a publication and cannot be laxer than the pages it mirrors.
 */
function isPushableSession(session: AcceleventsSourceSession): boolean {
  return isProgramSession(session) && session.contentStatus === "PUBLISHED";
}

/**
 * Sessions held back *solely* because they are unpublished — accepted or
 * guaranteed, and would ship the moment an organizer publishes them. A rejected
 * proposal is not counted: it is not something an operator can act on.
 */
export function countUnpublishedExclusions(sessions: readonly AcceleventsSourceSession[]): number {
  return sessions.filter(
    (session) => isProgramSession(session) && session.contentStatus !== "PUBLISHED",
  ).length;
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

/**
 * The operator-facing count summary — unchanged.
 *
 * The unpublished-exclusion count is deliberately NOT folded in here: the
 * operations panel renders every numeric field of this object as
 * "<n> <fieldname>", so a fourth key would surface as
 * "2 excludedunpublishedsessions" in the operator's own summary line. It ships
 * as a sibling `excluded` field on the response instead, matching the Airtable
 * route, and the panel states it in its own sentence.
 */
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
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new AcceleventsPushError(response.status);
}
