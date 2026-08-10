/**
 * Pure view logic for the public speaker gallery.
 *
 * Two honesty rules drive this module. A card must never print the same
 * manufactured filler as every other card when a profile field is missing — the
 * fallback is derived from that speaker's own programme instead. And a card
 * must never invent a time or a room it does not have: each part of a session
 * line is included only when the projection actually carries it.
 */
import { formatDayLabel, formatTime, zonedParts } from "./tz";

export type SpeakerViewSession = {
  id: string;
  title: string;
  track: { name: string } | null;
  startsAt: string | null;
  endsAt: string | null;
  room: string | null;
};

export type SpeakerViewProfile = {
  name: string;
  bio: string | null;
  company: string | null;
  jobTitle: string | null;
  headshotUrl: string | null;
  sessions: SpeakerViewSession[];
};

/** Tracks listed inline on a card before the rest are summarised. */
const MAX_INLINE_TRACKS = 2;

/** The real role line: title, employer, or both. Null when neither is stored. */
export function speakerHeadline(speaker: Pick<SpeakerViewProfile, "jobTitle" | "company">): string | null {
  const jobTitle = speaker.jobTitle?.trim() || null;
  const company = speaker.company?.trim() || null;
  if (jobTitle && company) return `${jobTitle} at ${company}`;
  return jobTitle ?? company;
}

/**
 * Fallback line for a speaker with no stored title or employer.
 *
 * Built from their actual sessions and tracks, so two speakers with empty
 * profiles still read differently — the defect was every such card showing the
 * identical placeholder string.
 */
export function speakerCredit(speaker: Pick<SpeakerViewProfile, "sessions">): string | null {
  const count = speaker.sessions.length;
  if (count === 0) return null;

  const trackNames = [...new Set(
    speaker.sessions
      .map((session) => session.track?.name?.trim())
      .filter((name): name is string => Boolean(name)),
  )];

  const sessionPart = `${count} ${count === 1 ? "session" : "sessions"}`;
  if (trackNames.length === 0) return sessionPart;
  const shown = trackNames.slice(0, MAX_INLINE_TRACKS).join(", ");
  const extra = trackNames.length - MAX_INLINE_TRACKS;
  return `${sessionPart} · ${shown}${extra > 0 ? ` +${extra} more` : ""}`;
}

/** Headline when stored, otherwise the derived credit. Null only when neither exists. */
export function speakerDetailLine(speaker: SpeakerViewProfile): string | null {
  return speakerHeadline(speaker) ?? speakerCredit(speaker);
}

/**
 * "Tue, May 12 · 9:00 – 9:45 AM · Redwood Hall", omitting whatever is missing.
 * Returns null when the session carries neither a time nor a room.
 */
export function sessionPlacementLine(session: SpeakerViewSession, timeZone: string): string | null {
  const parts: string[] = [];

  if (session.startsAt) {
    const start = new Date(session.startsAt);
    if (!Number.isNaN(start.getTime())) {
      parts.push(formatDayLabel(zonedParts(session.startsAt, timeZone).dateKey, timeZone));
      const end = session.endsAt ? new Date(session.endsAt) : null;
      parts.push(
        end && !Number.isNaN(end.getTime())
          ? `${formatTime(session.startsAt, timeZone)}–${formatTime(session.endsAt!, timeZone)}`
          : formatTime(session.startsAt, timeZone),
      );
    }
  }

  const room = session.room?.trim();
  if (room) parts.push(room);

  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Alt text for a stored headshot. Decorative-empty alt hides who is pictured. */
export function headshotAlt(name: string): string {
  return `Headshot of ${name}`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}
