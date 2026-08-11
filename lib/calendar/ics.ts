/**
 * RFC 5545 iCalendar generation for session exports.
 *
 * Pure functions — no database, no I/O — so this is fully unit-testable and
 * safe to render from any route. Callers pass already-loaded session data.
 */

/**
 * One invited person, emitted as RFC 5545 §3.8.4.1 ATTENDEE.
 *
 * `PARTSTAT=NEEDS-ACTION;RSVP=TRUE` is what makes Gmail and Outlook render
 * accept/decline buttons instead of a passive "add to calendar" link, so it is
 * fixed here rather than left to callers to remember.
 */
export type IcsAttendee = {
  email: string;
  name?: string | null;
};

export type IcsEvent = {
  /**
   * Stable unique id. The session id is a good choice for an export; an
   * invitation needs one stable per (session, invitee) so a re-send updates
   * the recipient's existing entry instead of creating a second one.
   */
  uid: string;
  title: string;
  description?: string | null;
  /** Room / venue. */
  location?: string | null;
  startsAt: Date;
  endsAt: Date;
  /** Absolute URL to the session page, if known. */
  url?: string | null;
  /**
   * RFC 5545 §3.8.1.2 CATEGORIES — the calendar client's own grouping and
   * colour-coding hook. A conference's track is exactly this, and without it a
   * subscribed attendee sees fifteen identical grey blocks.
   */
  categories?: readonly string[] | null;
  organizerName?: string | null;
  organizerEmail?: string | null;
  /**
   * RFC 5545 §3.8.7.4 SEQUENCE — the revision number a calendar client compares
   * against the copy it already holds for this UID. An update that does not
   * raise it is entitled to be ignored, so a re-send after a schedule change
   * must carry a higher value than the send before it. Omitted entirely for
   * exports, where there is no revision to track.
   */
  sequence?: number | null;
  /**
   * Who this VEVENT is addressed to. Only invitations set this; a public export
   * must never name its readers to each other.
   */
  attendees?: readonly IcsAttendee[] | null;
  /** RFC 5545 §3.8.1.11 STATUS, e.g. CONFIRMED for a scheduled talk. */
  status?: "CONFIRMED" | "TENTATIVE" | "CANCELLED" | null;
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

/**
 * RFC 5545 §3.1 param-value quoting for things like `CN=`.
 *
 * A parameter value is not TEXT: backslash escaping does not apply to it, and a
 * value containing `:`, `;` or `,` must be DQUOTE-quoted instead. Control
 * characters and the quote character itself have no representation at all
 * inside one, so they are dropped rather than emitted — a stray CR here would
 * end the content line and let a display name forge a property.
 */
function icsParamValue(value: string): string {
  const clean = value.replace(/["\x00-\x1f\x7f]/g, "").trim();
  return /[:;,]/.test(clean) ? `"${clean}"` : clean;
}

/**
 * A `mailto:` address is part of the property value, so the same line-injection
 * concern applies. Addresses reaching here are already-persisted `User.email`
 * values; this is the belt that keeps one malformed row from corrupting a whole
 * calendar file.
 */
function icsMailto(email: string): string {
  return email.replace(/[\s"',;:<>\x00-\x1f\x7f]/g, "");
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
  // CATEGORIES is a comma-SEPARATED list, so the separator commas are
  // structural and only the commas inside each value are escaped. Blank
  // entries are dropped rather than emitted as an empty category.
  const categories = (event.categories ?? []).map((c) => c.trim()).filter(Boolean);
  if (categories.length > 0) {
    out.push(line("CATEGORIES", categories.map(escapeIcsText).join(",")));
  }
  if (event.organizerEmail) {
    const cn = event.organizerName ? `;CN=${icsParamValue(event.organizerName)}` : "";
    out.push(foldIcsLine(`ORGANIZER${cn}:mailto:${icsMailto(event.organizerEmail)}`));
  }
  // Every ATTENDEE is a required participant whose answer is being asked for:
  // that pair of parameters is what turns an attached file into an invitation
  // a client will offer to accept or decline.
  for (const attendee of event.attendees ?? []) {
    const address = icsMailto(attendee.email);
    if (!address) continue;
    const cn = attendee.name ? `;CN=${icsParamValue(attendee.name)}` : "";
    out.push(foldIcsLine(
      `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE${cn}:mailto:${address}`,
    ));
  }
  if (event.status) out.push(line("STATUS", event.status));
  // Emitted only when a caller tracks revisions. RFC 5545 defaults an absent
  // SEQUENCE to 0, so an export that never revises anything stays silent rather
  // than repeatedly asserting revision zero.
  if (typeof event.sequence === "number" && Number.isFinite(event.sequence)) {
    out.push(line("SEQUENCE", String(Math.max(0, Math.trunc(event.sequence)))));
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
  options: {
    method?: "PUBLISH" | "REQUEST";
    calendarName?: string;
    /**
     * X-WR-CALDESC — the companion of X-WR-CALNAME that calendar clients show
     * as the calendar's description. This is where a bounded export tells its
     * reader it is incomplete: a downloaded `.ics` keeps speaking long after
     * the page is closed, so a response header or JSON field cannot reach it.
     */
    calendarDescription?: string;
    now?: Date;
  } = {},
): string {
  const { method = "PUBLISH", calendarName, calendarDescription, now = new Date() } = options;

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

  if (calendarDescription) {
    lines.push(line("X-WR-CALDESC", escapeIcsText(calendarDescription)));
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
