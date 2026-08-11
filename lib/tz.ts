/**
 * Event-timezone helpers.
 *
 * Schedule slots are stored as UTC instants but an agenda is always reasoned
 * about in the event's local time ("the 10am keynote"). Rendering with the
 * browser's timezone would shift every session for a remote admin, so all
 * agenda formatting and grid math goes through these helpers using the event's
 * stored IANA timezone.
 */

/** Minutes the given timezone is ahead of UTC at that instant (DST-aware). */
export function tzOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

type DateTimeFormatFactory = (
  locales?: string | string[],
  options?: Intl.DateTimeFormatOptions,
) => Intl.DateTimeFormat;

/**
 * Validate an IANA identifier without logging ordinary invalid user input.
 * ECMA-402 specifies RangeError for an invalid time zone; other formatter
 * failures are operational faults and must not be mistaken for bad input.
 */
export function isIanaTimeZone(
  value: string,
  createFormatter: DateTimeFormatFactory = Intl.DateTimeFormat,
): boolean {
  try {
    createFormatter("en-US", { timeZone: value });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

export type ZonedParts = { dateKey: string; hour: number; minute: number; minutesOfDay: number };

/** Break a UTC ISO string into event-local calendar parts. */
export function zonedParts(iso: string, timeZone: string): ZonedParts {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  return {
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
    hour,
    minute,
    minutesOfDay: hour * 60 + minute,
  };
}

/** Convert an event-local date + time into a UTC ISO instant. */
export function zonedToUtcIso(dateKey: string, time: string, timeZone: string): string {
  const naive = new Date(`${dateKey}T${time}:00Z`);
  const offset = tzOffsetMinutes(naive, timeZone);
  // Re-derive the offset at the corrected instant so DST boundaries land right.
  const corrected = new Date(naive.getTime() - offset * 60000);
  const offset2 = tzOffsetMinutes(corrected, timeZone);
  return new Date(naive.getTime() - offset2 * 60000).toISOString();
}

export function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/**
 * Render an instant as a complete, stable event-local deadline or appointment.
 *
 * Dates reach both server-rendered pages and small client islands. Pinning both
 * the locale and the stored IANA zone prevents either the server's locale or a
 * remote speaker's browser zone from changing the actual date or time shown.
 */
export function formatEventDateTime(value: Date | string | null | undefined, timeZone: string): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

/**
 * Render an event's calendar span as one honest label.
 *
 * A multi-day listing that prints only `startsAt` reads as a one-day event, so
 * every public header goes through this. `formatRange` collapses shared parts
 * ("May 12 – 14, 2026") and prints a single date when the range is one day.
 * Locale and zone are pinned for the same reason the other helpers pin them.
 */
export function formatEventDateRange(
  startsAt: string | Date | null | undefined,
  endsAt: string | Date | null | undefined,
  timeZone: string,
): string | null {
  const start = startsAt ? new Date(startsAt) : null;
  if (!start || Number.isNaN(start.getTime())) return null;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const end = endsAt ? new Date(endsAt) : null;
  if (!end || Number.isNaN(end.getTime()) || end.getTime() < start.getTime()) {
    return formatter.format(start);
  }
  return formatter.formatRange(start, end);
}

/**
 * Label one event-local calendar day: "Tue, May 12".
 *
 * `dateKey` is *already* an event-local calendar key — every caller derives it
 * from `zonedParts(...).dateKey` or `eventDayKeys`, both of which have applied
 * the event's zone. So there is nothing left to convert: the label must render
 * the key's own year, month, day, and that date's weekday, unchanged.
 *
 * This used to build noon UTC and then read it back *in the event zone*, which
 * applied the offset a second time. For every zone at UTC+12 or later that
 * lands on the next calendar day — key `2026-05-12` rendered "Wed, May 13" in
 * Pacific/Auckland (+12), Pacific/Chatham (+12:45) and Pacific/Kiritimati
 * (+14). Reading noon UTC *as UTC* is the identity for every IANA zone, so the
 * label is now the key's own date everywhere, and unchanged for the zones that
 * were already right.
 *
 * `timeZone` stays in the signature — every call site passes it and `dayTabs`
 * takes this function as its labeller — but it is deliberately not consulted:
 * a calendar key has no instant left to interpret.
 */
export function formatDayLabel(dateKey: string, timeZone: string): string {
  void timeZone;
  // Noon keeps the value clear of both midnight boundaries; read as UTC it is
  // exactly the key's own calendar day.
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${dateKey}T12:00:00Z`));
}

/** Short timezone abbreviation, e.g. "PDT". */
export function tzAbbreviation(timeZone: string, at = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(at);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? timeZone;
}

/**
 * A public time range that says which clock it is on: "10:00 AM–10:45 AM PDT".
 *
 * A bare time on a public programme is ambiguous to every reader who is not
 * standing at the venue, and it is the one number an attendee acts on. The
 * abbreviation is derived **at the session's own start instant**, never at
 * "now": an event in May read in December must still say PDT, and defaulting
 * `tzAbbreviation` to the current date would have printed PST.
 *
 * `endIso` is optional so a session with a start but no stored end still gets a
 * labelled time rather than being dropped back to a bare one.
 */
export function formatTimeRange(
  startIso: string,
  endIso: string | null | undefined,
  timeZone: string,
): string {
  const zone = tzAbbreviation(timeZone, new Date(startIso));
  const start = formatTime(startIso, timeZone);
  return endIso ? `${start}–${formatTime(endIso, timeZone)} ${zone}` : `${start} ${zone}`;
}

/**
 * The header note naming the clock every time on the page is printed in.
 *
 * Pinned to real instants for the same reason as `formatTimeRange`, so the note
 * cannot drift with the reader's calendar. But one abbreviation is only honest
 * when the whole programme sits on one side of a DST transition: an event
 * running 31 Oct – 2 Nov in Los Angeles has PDT cards and PST cards on the same
 * page, and a header claiming "All times PDT" would contradict half of them.
 *
 * So the caller passes every instant the page displays, and:
 *
 *  - all on one offset  -> "All times PDT", the useful, specific answer;
 *  - spanning a change  -> "All times in America/Los_Angeles", which explains
 *    the per-card abbreviations instead of contradicting them.
 *
 * Callers pass the event's own bounds AND the sessions' instants, not the
 * bounds alone: `eventDayKeys` deliberately unions in days holding sessions
 * that fall outside the stored `startsAt..endsAt`, so an event with absent or
 * stale dates can still display instants its bounds never covered.
 *
 * Invalid and absent entries are skipped rather than defaulting to "now",
 * which would let a corrupt row silently flip the label. If nothing usable is
 * supplied at all, it falls back to the current instant so the note is never
 * blank.
 */
export function timeZoneNote(
  timeZone: string,
  instants: ReadonlyArray<string | Date | null | undefined> = [],
): string {
  // One formatter for the whole scan: `formatToParts` is stateless, and the
  // agenda read is capped at hundreds of sessions.
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" });
  const abbreviationAt = (date: Date) =>
    formatter.formatToParts(date).find((part) => part.type === "timeZoneName")?.value ?? timeZone;

  let seen: string | null = null;
  for (const value of instants) {
    if (value === null || value === undefined) continue;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) continue;

    const abbreviation = abbreviationAt(date);
    if (seen === null) seen = abbreviation;
    // Early exit: a second distinct offset is all it takes, and the rest of the
    // scan cannot change the answer.
    else if (abbreviation !== seen) return `All times in ${timeZone}`;
  }

  return `All times ${seen ?? abbreviationAt(new Date())}`;
}

export function minutesToTimeInput(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
