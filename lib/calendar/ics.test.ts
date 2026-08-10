import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIcsCalendar, escapeIcsText, foldIcsLine, formatIcsDate, icsFilename } from "./ics";

const NOW = new Date("2026-04-01T12:00:00.000Z");

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

test("escapes titles containing commas and semicolons", () => {
  const ics = buildIcsCalendar([{ ...baseEvent, title: "Scaling, Sharding; and You" }], { now: NOW });
  assert.ok(ics.includes("SUMMARY:Scaling\\, Sharding\\; and You"));
});

test("builds safe filenames", () => {
  assert.equal(icsFilename("Scaling Vector Search"), "scaling-vector-search.ics");
  assert.equal(icsFilename("  Weird///Title!!  "), "weird-title.ics");
  assert.equal(icsFilename("!!!"), "session.ics");
});
