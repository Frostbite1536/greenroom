/**
 * GRA-TZ — the shared zone list behind both time-zone pickers.
 *
 * `timeZoneOptions` is deliberately pure and takes the runtime's zone list as
 * an argument, so the ordering, de-duplication and degraded-runtime cases are
 * all testable without depending on the ICU data this test process happens to
 * ship. The two environment readers are tested against a stubbed `Intl`, the
 * same way `lib/tz.test.ts` pins the formatter locale.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMON_TIME_ZONES,
  FALLBACK_TIME_ZONE,
  detectTimeZone,
  supportedTimeZones,
  timeZoneOptions,
} from "./event-settings-form";

/** Swap one `Intl` member for the duration of `run`, then put it back. */
function withIntl(name: "supportedValuesOf" | "DateTimeFormat", value: unknown, run: () => void) {
  const descriptor = Object.getOwnPropertyDescriptor(Intl, name);
  if (!descriptor) throw new Error(`Intl.${name} must be configurable for this test`);
  Object.defineProperty(Intl, name, { configurable: true, writable: true, value });
  try {
    run();
  } finally {
    Object.defineProperty(Intl, name, descriptor);
  }
}

test("the offered list is not limited to the common zones when the runtime knows more", () => {
  // The reported defect was a one-entry dropdown. Twelve was never enough
  // either: an organizer in Auckland, Kolkata or Nairobi had no suggestion.
  const options = timeZoneOptions(["Pacific/Auckland", "Asia/Kolkata", "Africa/Nairobi", "UTC"]);
  assert.ok(options.length > COMMON_TIME_ZONES.length);
  for (const zone of ["Pacific/Auckland", "Asia/Kolkata", "Africa/Nairobi"]) {
    assert.ok(options.includes(zone), `${zone} is not offered`);
  }
  // Against this runtime's real zone data the list is hundreds long, not twelve.
  const real = timeZoneOptions(supportedTimeZones());
  assert.ok(real.length > 100, `the real runtime offered only ${real.length} zones`);
  assert.ok(real.includes("Pacific/Auckland"));
});

test("the common zones stay first, in order, and appear exactly once", () => {
  const options = timeZoneOptions(["Africa/Nairobi", "UTC", "Europe/London", "Asia/Tokyo"]);
  assert.deepEqual(options.slice(0, COMMON_TIME_ZONES.length), COMMON_TIME_ZONES);
  // A zone the runtime also reports must not be suggested twice: a datalist
  // renders duplicates as duplicate rows.
  assert.equal(new Set(options).size, options.length);
  for (const zone of ["UTC", "Europe/London", "Asia/Tokyo"]) {
    assert.equal(options.filter((option) => option === zone).length, 1, zone);
  }
  assert.ok(options.includes("Africa/Nairobi"));
});

test("a runtime with no zone data degrades to exactly the common zones, never to none", () => {
  // The picker is free text and the server is the authority, but an empty
  // datalist would be a worse regression than the twelve it replaced.
  assert.deepEqual(timeZoneOptions(null), COMMON_TIME_ZONES);
  assert.deepEqual(timeZoneOptions(undefined), COMMON_TIME_ZONES);
  assert.deepEqual(timeZoneOptions([]), COMMON_TIME_ZONES);
  assert.deepEqual(timeZoneOptions(), COMMON_TIME_ZONES);
});

test("supportedTimeZones reports null rather than throwing on a runtime that cannot answer", () => {
  // Both failure shapes: the API missing outright, and an API that is present
  // but ships no zone data.
  withIntl("supportedValuesOf", undefined, () => {
    assert.equal(supportedTimeZones(), null);
    assert.deepEqual(timeZoneOptions(supportedTimeZones()), COMMON_TIME_ZONES);
  });
  withIntl("supportedValuesOf", () => { throw new RangeError("no zone data"); }, () => {
    assert.equal(supportedTimeZones(), null);
  });
  // Unstubbed, this runtime does answer, and answers with real IANA zones.
  const zones = supportedTimeZones();
  assert.ok(zones && zones.includes("Europe/London"));
});

test("detectTimeZone names the visitor's own zone and falls back to UTC, never to empty", () => {
  const resolved = detectTimeZone();
  assert.equal(typeof resolved, "string");
  assert.notEqual(resolved, "");
  assert.equal(resolved, Intl.DateTimeFormat().resolvedOptions().timeZone);

  // A runtime that resolves no zone must yield the same value the server
  // rendered, not an empty box the create call would then reject.
  withIntl("DateTimeFormat", function DateTimeFormatStub() {
    return { resolvedOptions: () => ({ timeZone: undefined }) };
  }, () => {
    assert.equal(detectTimeZone(), FALLBACK_TIME_ZONE);
  });
  withIntl("DateTimeFormat", function DateTimeFormatStub() {
    throw new RangeError("no ICU");
  }, () => {
    assert.equal(detectTimeZone(), FALLBACK_TIME_ZONE);
  });
  assert.equal(FALLBACK_TIME_ZONE, "UTC");
});
