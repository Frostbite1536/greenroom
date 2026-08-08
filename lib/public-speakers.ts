export const PUBLIC_SPEAKER_LIMITS = {
  speakers: 200,
  sessionsPerSpeaker: 20,
} as const;

export type PublicSpeakerTrack = {
  name: string;
};

export type PublicSpeakerSession = {
  id: string;
  title: string;
  track: PublicSpeakerTrack | null;
};

export type PublicSpeaker = {
  name: string;
  bio: string | null;
  company: string | null;
  jobTitle: string | null;
  headshotUrl: string | null;
  sessions: PublicSpeakerSession[];
  sessionsTruncated: boolean;
};

export type PublicSpeakers = {
  event: {
    name: string;
    slug: string;
    timezone: string;
    startsAt: string | null;
    endsAt: string | null;
  };
  tracks: PublicSpeakerTrack[];
  speakers: PublicSpeaker[];
  truncated: boolean;
};

export type PublicSpeakerSource = {
  id: string;
  name: string;
  avatarUrl: string | null;
  speakerProfile: {
    bio: string | null;
    company: string | null;
    jobTitle: string | null;
    headshotUrl: string | null;
  } | null;
  sessionSpeakers: Array<{
    session: {
      id: string;
      title: string;
      scheduleSlot: { track: { name: string } | null } | null;
    };
  }>;
};

type SpeakerAccumulator = PublicSpeaker & { sortKey: string };

function sessionProjection(source: PublicSpeakerSource["sessionSpeakers"][number]): PublicSpeakerSession | null {
  if (!source.session.scheduleSlot) return null;
  return {
    id: source.session.id,
    title: source.session.title,
    track: source.session.scheduleSlot.track ? { name: source.session.scheduleSlot.track.name } : null,
  };
}

export function safePublicImageUrl(value: string | null | undefined): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Projects scheduled, public-program sessions into an event-scoped gallery.
 * User IDs are used only for server-side deduplication and never leave this
 * serializer. Email, private profile fields, and review data are not accepted.
 */
export function buildPublicSpeakers(
  event: {
    name: string;
    slug: string;
    timezone: string;
    startsAt: Date | null;
    endsAt: Date | null;
  },
  sourceSpeakers: PublicSpeakerSource[],
): PublicSpeakers {
  const tracks = new Map<string, PublicSpeakerTrack>();
  const visibleSources = sourceSpeakers.slice(0, PUBLIC_SPEAKER_LIMITS.speakers);
  const speakers: SpeakerAccumulator[] = visibleSources.map((user) => {
    const profile = user.speakerProfile;
    const sessions = user.sessionSpeakers
      .slice(0, PUBLIC_SPEAKER_LIMITS.sessionsPerSpeaker)
      .map(sessionProjection)
      .filter((session): session is PublicSpeakerSession => Boolean(session));

    for (const session of sessions) {
      if (session.track && !tracks.has(session.track.name)) tracks.set(session.track.name, session.track);
    }

    return {
      sortKey: user.id,
      name: user.name,
      bio: profile?.bio ?? null,
      company: profile?.company ?? null,
      jobTitle: profile?.jobTitle ?? null,
      headshotUrl: safePublicImageUrl(profile?.headshotUrl ?? user.avatarUrl),
      sessions,
      sessionsTruncated: user.sessionSpeakers.length > PUBLIC_SPEAKER_LIMITS.sessionsPerSpeaker,
    };
  });

  return {
    event: {
      name: event.name,
      slug: event.slug,
      timezone: event.timezone,
      startsAt: event.startsAt?.toISOString() ?? null,
      endsAt: event.endsAt?.toISOString() ?? null,
    },
    tracks: [...tracks.values()],
    speakers: speakers
      .sort((a, b) => a.name.localeCompare(b.name) || a.sortKey.localeCompare(b.sortKey))
      .map(({ sortKey: _sortKey, ...speaker }) => speaker),
    truncated: sourceSpeakers.length > PUBLIC_SPEAKER_LIMITS.speakers,
  };
}
