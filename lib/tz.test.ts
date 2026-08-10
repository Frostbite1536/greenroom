import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatDayLabel,
  formatEventDateRange,
  formatEventDateTime,
  formatTime,
  formatTimeRange,
  timeZoneNote,
  tzAbbreviation,
  zonedParts,
  zonedToUtcIso,
} from "./tz";

const LOS_ANGELES = "America/Los_Angeles";

test("converts the seeded Los Angeles event boundary and agenda time to UTC", () => {
  assert.equal(zonedToUtcIso("2026-05-12", "00:00", LOS_ANGELES), "2026-05-12T07:00:00.000Z");
  assert.equal(zonedToUtcIso("2026-05-12", "09:00", LOS_ANGELES), "2026-05-12T16:00:00.000Z");
});

test("uses the daylight-saving offset after Los Angeles spring-forward", () => {
  assert.equal(zonedToUtcIso("2026-03-08", "09:00", LOS_ANGELES), "2026-03-08T16:00:00.000Z");
});

test("round-trips an event-local deadline date", () => {
  const deadline = zonedToUtcIso("2026-05-12", "23:59", LOS_ANGELES);
  assert.equal(zonedParts(deadline, LOS_ANGELES).dateKey, "2026-05-12");
});

test("renders deadlines in the event timezone rather than the runtime timezone", () => {
  assert.equal(
    formatEventDateTime("2026-05-02T06:59:00.000Z", LOS_ANGELES),
    "Fri, May 1, 2026, 11:59 PM PDT",
  );
  assert.equal(
    formatEventDateTime("2026-05-02T06:59:00.000Z", "America/New_York"),
    "Sat, May 2, 2026, 2:59 AM EDT",
  );
});

test("pins agenda and embed formatter output to en-US instead of the runtime default", () => {
  const nativeDateTimeFormat = Intl.DateTimeFormat;
  const descriptor = Object.getOwnPropertyDescriptor(Intl, "DateTimeFormat");
  const seenLocales: Array<string | string[] | undefined> = [];

  if (!descriptor) {
    throw new Error("Intl.DateTimeFormat must be configurable for this test");
  }

  Object.defineProperty(Intl, "DateTimeFormat", {
    configurable: true,
    writable: true,
    value: new Proxy(nativeDateTimeFormat, {
      construct(target, args, newTarget) {
        seenLocales.push(args[0] as string | string[] | undefined);
        return Reflect.construct(target, args, newTarget);
      },
    }),
  });

  try {
    assert.equal(
      formatTime("2026-05-12T16:05:00.000Z", LOS_ANGELES),
      "9:05 AM",
    );
    assert.equal(formatDayLabel("2026-05-12", LOS_ANGELES), "Tue, May 12");
  } finally {
    Object.defineProperty(Intl, "DateTimeFormat", descriptor);
  }

  assert.deepEqual(seenLocales, ["en-US", "en-US"]);
});

// Intl range output separates the parts with THIN SPACE (U+2009) around the en
// dash. Normalising here keeps the assertions readable while still proving the
// dates themselves; the smoke script normalises the same way.
const plain = (value: string | null) => value?.replace(/ /g, " ") ?? null;

test("formatEventDateRange spans a multi-day event instead of printing only its first day", () => {
  // The seeded event runs May 12–14 local. Printing `startsAt` alone (the old
  // embed header) claimed a three-day conference lasted one day.
  assert.equal(
    plain(formatEventDateRange("2026-05-12T07:00:00.000Z", "2026-05-15T06:59:00.000Z", LOS_ANGELES)),
    "May 12 – 14, 2026",
  );
});

test("formatEventDateRange collapses a single-day event and survives missing or inverted ends", () => {
  assert.equal(
    formatEventDateRange("2026-05-12T17:00:00.000Z", "2026-05-12T23:00:00.000Z", LOS_ANGELES),
    "May 12, 2026",
  );
  assert.equal(formatEventDateRange("2026-05-12T17:00:00.000Z", null, LOS_ANGELES), "May 12, 2026");
  // An inverted range is bad data, not a reason to throw on a public page.
  assert.equal(
    formatEventDateRange("2026-05-12T17:00:00.000Z", "2026-05-01T17:00:00.000Z", LOS_ANGELES),
    "May 12, 2026",
  );
  assert.equal(formatEventDateRange(null, null, LOS_ANGELES), null);
  assert.equal(formatEventDateRange("not-a-date", null, LOS_ANGELES), null);
});

test("formatEventDateRange renders in the event timezone, not the runtime zone", () => {
  // 07:00Z on May 12 is still May 12 in Los Angeles but May 12 evening in Tokyo;
  // the boundary case that matters is the UTC-midnight-crossing end instant.
  assert.equal(
    plain(formatEventDateRange("2026-05-12T02:00:00.000Z", "2026-05-13T02:00:00.000Z", LOS_ANGELES)),
    "May 11 – 12, 2026",
  );
});

test("a public time range names the clock it is on", () => {
  assert.equal(
    formatTimeRange("2026-05-12T17:00:00.000Z", "2026-05-12T17:45:00.000Z", LOS_ANGELES),
    "10:00 AM–10:45 AM PDT",
  );
  // A session with a start but no stored end is still labelled.
  assert.equal(formatTimeRange("2026-05-12T17:00:00.000Z", null, LOS_ANGELES), "10:00 AM PDT");
});

test("the zone label is derived at the session's own instant, never at 'now'", () => {
  // The regression this exists to prevent: `tzAbbreviation` defaults `at` to
  // the current date, so a summer programme read in winter would have printed
  // PST over every May session. Both of these are the SAME zone, one instant
  // either side of the DST boundary.
  assert.equal(
    formatTimeRange("2026-05-12T17:00:00.000Z", "2026-05-12T17:45:00.000Z", LOS_ANGELES),
    "10:00 AM–10:45 AM PDT",
  );
  assert.equal(
    formatTimeRange("2026-01-12T17:00:00.000Z", "2026-01-12T17:45:00.000Z", LOS_ANGELES),
    "9:00 AM–9:45 AM PST",
  );
});

test("the header note pins its abbreviation to the event, not the reader's calendar", () => {
  assert.equal(timeZoneNote(LOS_ANGELES, "2026-05-12T17:00:00.000Z"), "All times PDT");
  assert.equal(timeZoneNote(LOS_ANGELES, "2026-01-12T17:00:00.000Z"), "All times PST");
  // An event with no stored start still gets an honest label rather than none.
  assert.match(timeZoneNote(LOS_ANGELES, null), /^All times P[DS]T$/);
  // A corrupt stored instant must not produce "All times Invalid Date".
  assert.match(timeZoneNote(LOS_ANGELES, "not-a-date"), /^All times P[DS]T$/);
});

test("tzAbbreviation itself is DST-aware at the instant it is given", () => {
  assert.equal(tzAbbreviation(LOS_ANGELES, new Date("2026-05-12T17:00:00.000Z")), "PDT");
  assert.equal(tzAbbreviation(LOS_ANGELES, new Date("2026-01-12T17:00:00.000Z")), "PST");
});
