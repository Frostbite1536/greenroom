/**
 * RFC 5545 iCalendar generation for session exports.
 *
 * Pure functions — no database, no I/O — so this is fully unit-testable and
 * safe to render from any route. Callers pass already-loaded session data.
 */

export type IcsEvent = {
  /** Stable unique id; the session id is a good choice. */
  uid: string;
  title: string;
  description?: string | null;
  /** Room / venue. */
  location?: string | null;
  startsAt: Date;
  endsAt: Date;
  /** Absolute URL to the session page, if known. */
  url?: string | null;
  organizerName?: string | null;
  organizerEmail?: string | null;
};

const PRODID = "-//Greenroom//Program Manager//EN";

/** RFC 5545 §3.3.5 UTC date-time: 19980118T230000Z */
export function formatIcsDate(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}

/**
 * RFC 5545 §3.3.11 TEXT escaping: backslash, semicolon, comma and newlines.
 * Order matters — backslash must be escaped first.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n/g, "\\n")
    .replace(/[\r\n]/g, "\\n");
}

/**
 * RFC 5545 §3.1 content line folding: lines must not exceed 75 octets.
 * Continuation lines begin with a single space. We fold on octets (not UTF-16
 * code units) so multi-byte characters cannot push a line over the limit.
 */
export function foldIcsLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;

  const parts: string[] = [];
  let start = 0;
  let limit = 75;

  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Never split a multi-byte character: back off to a lead byte boundary.
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74; // continuation lines lose one octet to the leading space
  }

  return parts.join("\r\n ");
}

function line(name: string, value: string): string {
  return foldIcsLine(`${name}:${value}`);
}

/** Build a single VEVENT block. */
function buildEvent(event: IcsEvent, stamp: Date): string[] {
  const out = [
    "BEGIN:VEVENT",
    line("UID", escapeIcsText(event.uid)),
    line("DTSTAMP", formatIcsDate(stamp)),
    line("DTSTART", formatIcsDate(event.startsAt)),
    line("DTEND", formatIcsDate(event.endsAt)),
    line("SUMMARY", escapeIcsText(event.title)),
  ];

  if (event.description) out.push(line("DESCRIPTION", escapeIcsText(event.description)));
  if (event.location) out.push(line("LOCATION", escapeIcsText(event.location)));
  if (event.url) out.push(line("URL", escapeIcsText(event.url)));
  if (event.organizerEmail) {
    const cn = event.organizerName ? `;CN=${escapeIcsText(event.organizerName)}` : "";
    out.push(foldIcsLine(`ORGANIZER${cn}:mailto:${event.organizerEmail}`));
  }

  out.push("END:VEVENT");
  return out;
}

/**
 * Build a complete .ics calendar.
 *
 * `method` defaults to PUBLISH (a downloadable calendar). Use REQUEST when the
 * file is attached to an invitation email so clients render accept/decline.
 */
export function buildIcsCalendar(
  events: IcsEvent[],
  options: { method?: "PUBLISH" | "REQUEST"; calendarName?: string; now?: Date } = {},
): string {
  const { method = "PUBLISH", calendarName, now = new Date() } = options;

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    line("PRODID", PRODID),
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
  ];

  if (calendarName) {
    lines.push(line("X-WR-CALNAME", escapeIcsText(calendarName)));
  }

  for (const event of events) lines.push(...buildEvent(event, now));

  lines.push("END:VCALENDAR");
  // RFC 5545 requires CRLF line endings and a trailing CRLF.
  return `${lines.join("\r\n")}\r\n`;
}

/** Filename-safe slug for the downloaded file. */
export function icsFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "session"}.ics`;
}
