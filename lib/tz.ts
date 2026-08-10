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

export function formatDayLabel(dateKey: string, timeZone: string): string {
  // Noon avoids any DST edge when labelling a whole day.
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
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

export function minutesToTimeInput(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
