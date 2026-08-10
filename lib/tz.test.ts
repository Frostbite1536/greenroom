import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatDayLabel,
  formatEventDateRange,
  formatEventDateTime,
  formatTime,
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
