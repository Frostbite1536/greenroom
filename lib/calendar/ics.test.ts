import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIcsCalendar, escapeIcsText, foldIcsLine, formatIcsDate, icsFilename } from "./ics";

const NOW = new Date("2026-04-01T12:00:00.000Z");

/**
 * RFC 5545 folds any content line past 75 octets, so a full ATTENDEE line is
 * split in the real file. Assertions about a line's *content* unfold first;
 * assertions about line structure deliberately do not.
 */
const unfold = (ics: string) => ics.split("\r\n ").join("");

const baseEvent = {
  uid: "session-123",
  title: "Scaling Vector Search",
  startsAt: new Date("2026-05-12T09:00:00.000Z"),
  endsAt: new Date("2026-05-12T09:30:00.000Z"),
};

test("formats UTC date-times per RFC 5545", () => {
  assert.equal(formatIcsDate(new Date("2026-05-12T09:00:00.000Z")), "20260512T090000Z");
});

test("escapes TEXT special characters in the right order", () => {
  assert.equal(escapeIcsText("a;b,c"), "a\\;b\\,c");
  assert.equal(escapeIcsText("back\\slash"), "back\\\\slash");
  assert.equal(escapeIcsText("line1\nline2"), "line1\\nline2");
  assert.equal(escapeIcsText("crlf\r\nhere"), "crlf\\nhere");
});

test("does not fold short lines", () => {
  assert.equal(foldIcsLine("SUMMARY:short"), "SUMMARY:short");
});

test("folds long lines to 75 octets with a leading space on continuations", () => {
  const folded = foldIcsLine(`SUMMARY:${"x".repeat(200)}`);
  const parts = folded.split("\r\n");
  assert.ok(parts.length > 1, "expected folding");
  assert.ok(Buffer.from(parts[0], "utf8").length <= 75, "first line within 75 octets");
  for (const part of parts.slice(1)) {
    assert.ok(part.startsWith(" "), "continuation starts with a space");
    assert.ok(Buffer.from(part, "utf8").length <= 75, "continuation within 75 octets");
  }
});

test("never splits a multi-byte character when folding", () => {
  const folded = foldIcsLine(`SUMMARY:${"é".repeat(80)}`);
  // If a character were split, re-joining would produce replacement chars.
  const rejoined = folded.split("\r\n ").join("");
  assert.ok(!rejoined.includes("\uFFFD"), "no replacement characters");
  assert.equal(rejoined, `SUMMARY:${"é".repeat(80)}`);
});

test("builds a valid calendar skeleton with CRLF endings", () => {
  const ics = buildIcsCalendar([baseEvent], { now: NOW });
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.ok(ics.includes("VERSION:2.0"));
  assert.ok(ics.includes("METHOD:PUBLISH"));
  assert.ok(ics.includes("BEGIN:VEVENT"));
  assert.ok(ics.includes("END:VEVENT"));
  assert.ok(ics.includes("UID:session-123"));
  assert.ok(ics.includes("DTSTART:20260512T090000Z"));
  assert.ok(ics.includes("DTEND:20260512T093000Z"));
  assert.ok(ics.includes("DTSTAMP:20260401T120000Z"));
  assert.ok(ics.includes("SUMMARY:Scaling Vector Search"));
});

test("omits optional properties when absent", () => {
  const ics = buildIcsCalendar([baseEvent], { now: NOW });
  assert.ok(!ics.includes("LOCATION:"));
  assert.ok(!ics.includes("DESCRIPTION:"));
  assert.ok(!ics.includes("ORGANIZER"));
});

test("includes optional properties when present", () => {
  const ics = buildIcsCalendar(
    [{ ...baseEvent, location: "Hall A", description: "A talk", url: "https://x.test/s/1", organizerName: "Maya Chen", organizerEmail: "maya@greenroom-hq.com" }],
    { now: NOW },
  );
  assert.ok(ics.includes("LOCATION:Hall A"));
  assert.ok(ics.includes("DESCRIPTION:A talk"));
  assert.ok(ics.includes("URL:https://x.test/s/1"));
  assert.ok(ics.includes("ORGANIZER;CN=Maya Chen:mailto:maya@greenroom-hq.com"));
});

test("supports METHOD:REQUEST for emailed invitations", () => {
  const ics = buildIcsCalendar([baseEvent], { method: "REQUEST", now: NOW });
  assert.ok(ics.includes("METHOD:REQUEST"));
});

test("emits one VEVENT per session for a full-schedule export", () => {
  const ics = buildIcsCalendar(
    [baseEvent, { ...baseEvent, uid: "session-456", title: "Second Talk" }],
    { calendarName: "Forward 2026", now: NOW },
  );
  assert.equal(ics.match(/BEGIN:VEVENT/g)?.length, 2);
  assert.ok(ics.includes("X-WR-CALNAME:Forward 2026"));
});

/**
 * NEW-1. A bounded export has to be able to say so inside the file — a
 * downloaded .ics outlives the response that carried it, so the JSON twin's
 * `truncated` field has no equivalent a reader would ever see. X-WR-CALDESC is
 * the companion of the X-WR-CALNAME already emitted here, and calendar clients
 * show it as the calendar's description.
 */
test("a calendar description rides in the file, escaped, and only when given", () => {
  const withDesc = buildIcsCalendar([baseEvent], {
    calendarName: "Forward 2026",
    calendarDescription: "First 500 sessions; the programme has more, see online.",
    now: NOW,
  });
  assert.ok(
    withDesc.includes("X-WR-CALDESC:First 500 sessions\\; the programme has more\\, see online."),
    "the description is present and RFC 5545 TEXT-escaped",
  );
  // Absent by default, so an untruncated export makes no claim at all.
  assert.ok(!buildIcsCalendar([baseEvent], { calendarName: "Forward 2026", now: NOW }).includes("X-WR-CALDESC"));
  assert.ok(!buildIcsCalendar([baseEvent], { calendarDescription: "", now: NOW }).includes("X-WR-CALDESC"));
});

test("escapes titles containing commas and semicolons", () => {
  const ics = buildIcsCalendar([{ ...baseEvent, title: "Scaling, Sharding; and You" }], { now: NOW });
  assert.ok(ics.includes("SUMMARY:Scaling\\, Sharding\\; and You"));
});

test("an invitation names its attendee and asks them to answer", () => {
  // PARTSTAT/RSVP is the difference between a calendar client offering
  // accept/decline and filing the file as a passive attachment.
  const ics = buildIcsCalendar(
    [{ ...baseEvent, attendees: [{ email: "ada@example.test", name: "Ada Lovelace" }], status: "CONFIRMED", sequence: 7 }],
    { method: "REQUEST", now: NOW },
  );
  assert.ok(
    unfold(ics).includes("ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Ada Lovelace:mailto:ada@example.test"),
    ics,
  );
  assert.ok(ics.includes("STATUS:CONFIRMED"));
  assert.ok(ics.includes("SEQUENCE:7"));
});

test("a display name that would break a content line is quoted or dropped, never emitted raw", () => {
  // A parameter value is not TEXT: a comma or colon inside one must be quoted,
  // and a CR would end the line and let a name forge a property.
  const ics = buildIcsCalendar(
    [{ ...baseEvent, attendees: [{ email: "ada@example.test", name: "Lovelace, Ada" }] }],
    { method: "REQUEST", now: NOW },
  );
  assert.ok(unfold(ics).includes('CN="Lovelace, Ada":mailto:ada@example.test'), ics);

  const injected = buildIcsCalendar(
    [{ ...baseEvent, attendees: [{ email: "ada@example.test", name: "Ada\r\nSUMMARY:forged" }] }],
    { method: "REQUEST", now: NOW },
  );
  // The forged text survives only as inert characters inside a quoted parameter
  // value. What must not survive is the line break that would have made it a
  // property of its own — there is still exactly one real SUMMARY line.
  assert.ok(!injected.includes("\r\nSUMMARY:forged"));
  assert.equal(unfold(injected).split("\r\n").filter((line) => line.startsWith("SUMMARY:")).length, 1);
});

test("an export makes no attendee, status or revision claim it was not given", () => {
  // The public schedule download must never name its readers to each other,
  // and it has no revisions to assert.
  const ics = buildIcsCalendar([baseEvent], { now: NOW });
  assert.ok(!ics.includes("ATTENDEE"));
  assert.ok(!ics.includes("SEQUENCE"));
  assert.ok(!ics.includes("STATUS"));
  assert.ok(!buildIcsCalendar([{ ...baseEvent, attendees: [], sequence: null, status: null }], { now: NOW }).includes("ATTENDEE"));
});

test("a negative or fractional revision clamps to a whole non-negative SEQUENCE", () => {
  assert.ok(buildIcsCalendar([{ ...baseEvent, sequence: -5 }], { now: NOW }).includes("SEQUENCE:0"));
  assert.ok(buildIcsCalendar([{ ...baseEvent, sequence: 3.9 }], { now: NOW }).includes("SEQUENCE:3"));
  assert.ok(!buildIcsCalendar([{ ...baseEvent, sequence: Number.NaN }], { now: NOW }).includes("SEQUENCE"));
});

test("builds safe filenames", () => {
  assert.equal(icsFilename("Scaling Vector Search"), "scaling-vector-search.ics");
  assert.equal(icsFilename("  Weird///Title!!  "), "weird-title.ics");
  assert.equal(icsFilename("!!!"), "session.ics");
});

test("a track reaches the calendar client as CATEGORIES", () => {
  // §5-6: without this a subscribed attendee sees an undifferentiated wall of
  // identical blocks — CATEGORIES is the grouping and colour hook every major
  // client already reads.
  const ics = buildIcsCalendar([{ ...baseEvent, categories: ["Applied AI"] }], { now: NOW });
  assert.ok(ics.includes("CATEGORIES:Applied AI"));
});

test("CATEGORIES separates values with commas and escapes only the ones inside", () => {
  // RFC 5545 §3.8.1.2 is a comma-SEPARATED list, so the separator is structural
  // and must not be escaped; a comma within one value must be.
  const ics = buildIcsCalendar(
    [{ ...baseEvent, categories: ["Mainstage", "Ops, SRE"] }],
    { now: NOW },
  );
  assert.ok(ics.includes("CATEGORIES:Mainstage,Ops\\, SRE"), ics);
});

test("an untracked session emits no CATEGORIES line at all", () => {
  // Never an empty or invented category: a client would render the blank as a
  // real group sitting alongside the real tracks.
  assert.ok(!buildIcsCalendar([baseEvent], { now: NOW }).includes("CATEGORIES"));
  assert.ok(!buildIcsCalendar([{ ...baseEvent, categories: [] }], { now: NOW }).includes("CATEGORIES"));
  assert.ok(!buildIcsCalendar([{ ...baseEvent, categories: null }], { now: NOW }).includes("CATEGORIES"));
  assert.ok(!buildIcsCalendar([{ ...baseEvent, categories: ["  ", ""] }], { now: NOW }).includes("CATEGORIES"));
});
