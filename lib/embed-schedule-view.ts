/**
 * Pure view logic for the public schedule embed.
 *
 * The embed renders on the server from URL parameters so that day tabs, the
 * track filter, and keyword search all work with JavaScript disabled and land
 * on shareable URLs. Everything that decides *what* is shown lives here as
 * plain functions: the component stays a thin renderer and this stays testable
 * without a DOM.
 *
 * The shapes below are structural copies of `PublicAgenda` from lib/data/reads.
 * They are declared locally on purpose — importing the reads module would drag
 * Prisma into a unit test that only needs arithmetic on strings and dates.
 */
import { zonedParts } from "./tz";

export type ScheduleViewTrack = { id: string; name: string; color: string };

export type ScheduleViewSession = {
  slotId: string;
  sessionId: string;
  title: string;
  description: string | null;
  format: string | null;
  room: { id: string; name: string };
  track: ScheduleViewTrack | null;
  /**
   * The proposal's topic, carried onto the talk at acceptance. Optional so a
   * caller built before this column existed still type-checks, and deliberately
   * distinct from `track`: a track is a schedule swimlane owned by the slot,
   * while a topic is what the speaker submitted under and survives unscheduling.
   */
  category?: { id: string; name: string } | null;
  startsAt: string;
  endsAt: string;
  speakers: string[];
};

export type ScheduleViewAgenda = {
  event: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    startsAt: string | null;
    endsAt: string | null;
  };
  tracks: ScheduleViewTrack[];
  sessions: ScheduleViewSession[];
  /** True when the event holds more placed sessions than one read materializes.
   *  Optional so a caller built before the bound existed still type-checks. */
  truncated?: boolean;
};

/**
 * What to tell a reader whose agenda was cut short, or null when it was not.
 * Never says "showing all 500 of 500" — a notice that reports no problem is a
 * notice that should not be rendered.
 */
export function agendaTruncationNotice(
  agenda: Pick<ScheduleViewAgenda, "sessions" | "truncated">,
): string | null {
  if (!agenda.truncated) return null;
  return `This schedule is unusually large, so only the first ${agenda.sessions.length} sessions are shown here. `
    + "Use the day tabs or search to narrow it, or open the event's own schedule page.";
}

export type ScheduleFilters = { track: string; day: string; q: string };

export type ScheduleDayTab = { key: string; label: string; count: number; current: boolean };

/** Characters of a description shown before the "Show more" control. */
export const DESCRIPTION_PREVIEW_CHARS = 180;

/**
 * Hard ceiling on generated day tabs. An event with a mistyped `endsAt` must
 * not turn one public page render into thousands of tab elements.
 */
export const MAX_EVENT_DAYS = 31;

/**
 * Ceiling on placed sessions materialized for one public agenda read (S20).
 *
 * The same shape as `PUBLIC_SPEAKER_LIMITS`: read this many plus one, render
 * this many, and say so when there are more. A public page cannot fail closed
 * the way an operator export does — refusing to render the programme because
 * an event is large would be worse than rendering it and admitting the cut.
 */
export const PUBLIC_AGENDA_LIMITS = { sessions: 500 } as const;

export const ALL = "all";

function addDay(dateKey: string, days: number): string {
  // Noon UTC keeps the arithmetic clear of any DST edge; only the calendar
  // date is being advanced, never a wall-clock instant.
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Every day the schedule can show, as `YYYY-MM-DD` event-local keys.
 *
 * Derived from `Event.startsAt..endsAt` first — deriving them from placed
 * sessions instead is what made an event's last day unreachable until somebody
 * scheduled something on it. Days that hold sessions but fall outside the
 * stored event range are unioned in so no placed session becomes invisible.
 */
export function eventDayKeys(agenda: ScheduleViewAgenda): string[] {
  const tz = agenda.event.timezone;
  const keys = new Set<string>();

  if (agenda.event.startsAt) {
    const start = zonedParts(agenda.event.startsAt, tz).dateKey;
    const end = agenda.event.endsAt ? zonedParts(agenda.event.endsAt, tz).dateKey : start;
    let cursor = start;
    for (let i = 0; i < MAX_EVENT_DAYS && cursor <= end; i += 1) {
      keys.add(cursor);
      cursor = addDay(cursor, 1);
    }
  }

  for (const session of agenda.sessions) {
    keys.add(zonedParts(session.startsAt, tz).dateKey);
  }

  return [...keys].sort();
}

/** Resolve a `?track=` value to a real track id, or `all`. */
export function resolveTrack(agenda: ScheduleViewAgenda, value: string | undefined): string {
  if (!value || value === ALL) return ALL;
  return agenda.tracks.some((track) => track.id === value) ? value : ALL;
}

/** Resolve a `?day=` value to a real day key, or `all`. */
export function resolveDay(dayKeys: string[], value: string | undefined): string {
  if (!value || value === ALL) return ALL;
  return dayKeys.includes(value) ? value : ALL;
}

/** Trim and lower-case a `?q=`, bounding it so a giant URL cannot drive a scan. */
export function resolveQuery(value: string | undefined): string {
  return (value ?? "").slice(0, 200).trim();
}

export function matchesQuery(session: ScheduleViewSession, query: string): boolean {
  if (!query) return true;
  const needle = query.toLocaleLowerCase();
  const haystack = [
    session.title,
    session.description,
    session.format,
    session.room.name,
    session.track?.name ?? null,
    session.category?.name ?? null,
    ...session.speakers,
  ];
  return haystack.some((value) => Boolean(value) && value!.toLocaleLowerCase().includes(needle));
}

export function filterSessions(
  agenda: ScheduleViewAgenda,
  filters: Pick<ScheduleFilters, "track" | "q"> & { day?: string },
): ScheduleViewSession[] {
  const tz = agenda.event.timezone;
  return agenda.sessions.filter((session) => {
    if (filters.track !== ALL && session.track?.id !== filters.track) return false;
    if (filters.day && filters.day !== ALL && zonedParts(session.startsAt, tz).dateKey !== filters.day) return false;
    return matchesQuery(session, filters.q);
  });
}

/**
 * Tabs for every event day, with counts under the *other* active filters.
 *
 * A day with zero matches still gets a tab — that is the whole point of the
 * fix — so the reader can select it and be told plainly that nothing is
 * scheduled there yet.
 */
export function dayTabs(
  agenda: ScheduleViewAgenda,
  filters: ScheduleFilters,
  labeller: (dateKey: string, timeZone: string) => string,
): ScheduleDayTab[] {
  const tz = agenda.event.timezone;
  const withoutDay = filterSessions(agenda, { track: filters.track, q: filters.q });
  const counts = new Map<string, number>();
  for (const session of withoutDay) {
    const key = zonedParts(session.startsAt, tz).dateKey;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return eventDayKeys(agenda).map((key) => ({
    key,
    label: labeller(key, tz),
    count: counts.get(key) ?? 0,
    current: filters.day === key,
  }));
}

/** Group already-filtered sessions by event-local day, each day sorted by start. */
export function groupByDay(
  sessions: ScheduleViewSession[],
  timeZone: string,
): Array<[string, ScheduleViewSession[]]> {
  const map = new Map<string, ScheduleViewSession[]>();
  for (const session of sessions) {
    const key = zonedParts(session.startsAt, timeZone).dateKey;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(session);
  }
  for (const items of map.values()) {
    items.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.title.localeCompare(b.title));
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export type DescriptionSplit = { preview: string; truncated: boolean };

/**
 * Split a description into a preview and a truncation flag.
 *
 * The full text is always rendered inside the expandable region, so this only
 * decides how much shows while collapsed. Breaking on the last word boundary
 * avoids cutting a word in half mid-render.
 */
export function descriptionPreview(
  description: string | null,
  limit = DESCRIPTION_PREVIEW_CHARS,
): DescriptionSplit | null {
  const text = description?.trim();
  if (!text) return null;
  if (text.length <= limit) return { preview: text, truncated: false };

  const window = text.slice(0, limit);
  const lastSpace = window.lastIndexOf(" ");
  const preview = (lastSpace > limit * 0.6 ? window.slice(0, lastSpace) : window).trimEnd();
  return { preview, truncated: true };
}

export type ScheduleChipKind = "format" | "track" | "topic" | "room";

/**
 * Non-colour labels for a session: format, track, topic, room — in that order.
 *
 * The topic chip is what closes the "unlabelled coloured bar": a talk with no
 * schedule track renders a grey rail and, before this, no words explaining it.
 * It is a separate chip from the track rather than a fallback because the two
 * are different facts — a session can legitimately carry both, and quietly
 * printing a topic under a "Track" label would be a lie to a screen reader.
 */
export function sessionChips(session: ScheduleViewSession): Array<{ kind: ScheduleChipKind; label: string }> {
  const chips: Array<{ kind: ScheduleChipKind; label: string }> = [];
  if (session.format?.trim()) chips.push({ kind: "format", label: session.format.trim() });
  if (session.track) chips.push({ kind: "track", label: session.track.name });
  if (session.category?.name.trim()) chips.push({ kind: "topic", label: session.category.name.trim() });
  chips.push({ kind: "room", label: session.room.name });
  return chips;
}

/** Screen-reader prefix naming what a chip is, so the label is never bare. */
export function chipPrefix(kind: ScheduleChipKind): string {
  switch (kind) {
    case "format":
      return "Format";
    case "track":
      return "Track";
    case "topic":
      return "Topic";
    default:
      return "Room";
  }
}

/**
 * Build an `/embed/schedule` URL that keeps every other filter intact.
 *
 * `eventParam` is echoed exactly as it arrived (slug or id) so a host page's
 * `?event=` stays byte-identical across every link on the page.
 */
export function scheduleHref(
  eventParam: string | undefined,
  filters: ScheduleFilters,
  overrides: Partial<ScheduleFilters> = {},
): string {
  const next = { ...filters, ...overrides };
  const params = new URLSearchParams();
  if (eventParam) params.set("event", eventParam);
  if (next.track && next.track !== ALL) params.set("track", next.track);
  if (next.day && next.day !== ALL) params.set("day", next.day);
  if (next.q) params.set("q", next.q);
  const query = params.toString();
  return query ? `/embed/schedule?${query}` : "/embed/schedule";
}

/** One-line summary for the header: session count under the current filters. */
export function resultSummary(total: number, shown: number, filtered: boolean): string {
  const label = (n: number) => `${n} ${n === 1 ? "session" : "sessions"}`;
  return filtered ? `${label(shown)} of ${total}` : label(total);
}
