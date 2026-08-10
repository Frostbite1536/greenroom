import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_ROUND_WINDOW,
  formatRoundWindow,
  roundWindowError,
  roundWindowInput,
} from "./evaluation-round-window";

const LOS_ANGELES = "America/Los_Angeles";

test("a blank round window sends nothing, so an unspecified date stays unspecified", () => {
  assert.deepEqual(roundWindowInput(EMPTY_ROUND_WINDOW, LOS_ANGELES), {});
  assert.equal(roundWindowError(EMPTY_ROUND_WINDOW), null);
  assert.equal(formatRoundWindow(null, null, LOS_ANGELES), null);
});

test("either bound may be given on its own", () => {
  assert.deepEqual(
    Object.keys(roundWindowInput({ opensOn: "2026-03-02", closesOn: "" }, LOS_ANGELES)),
    ["startsAt"],
  );
  assert.deepEqual(
    Object.keys(roundWindowInput({ opensOn: "", closesOn: "2026-03-20" }, LOS_ANGELES)),
    ["endsAt"],
  );
  assert.equal(roundWindowError({ opensOn: "2026-03-02", closesOn: "" }), null);
  assert.equal(roundWindowError({ opensOn: "", closesOn: "2026-03-20" }), null);
});

test("the window is anchored to the event timezone, not the runtime one", () => {
  const input = roundWindowInput({ opensOn: "2026-03-02", closesOn: "2026-03-20" }, LOS_ANGELES);
  // Opens at local midnight while Los Angeles is still on PST (UTC-8), closes
  // on the last minute of the local day after the spring-forward to PDT (UTC-7).
  assert.equal(input.startsAt, "2026-03-02T08:00:00.000Z");
  assert.equal(input.endsAt, "2026-03-21T06:59:00.000Z");

  const utc = roundWindowInput({ opensOn: "2026-03-02", closesOn: "2026-03-20" }, "UTC");
  assert.equal(utc.startsAt, "2026-03-02T00:00:00.000Z");
  assert.equal(utc.endsAt, "2026-03-20T23:59:00.000Z");
});

test("the close date includes its own day rather than cutting it off at midnight", () => {
  const sameDay = roundWindowInput({ opensOn: "2026-03-02", closesOn: "2026-03-02" }, "UTC");
  assert.equal(sameDay.startsAt, "2026-03-02T00:00:00.000Z");
  assert.equal(sameDay.endsAt, "2026-03-02T23:59:00.000Z");
  assert.equal(roundWindowError({ opensOn: "2026-03-02", closesOn: "2026-03-02" }), null);
});

test("an inverted window is refused before it reaches the API", () => {
  assert.equal(
    roundWindowError({ opensOn: "2026-03-20", closesOn: "2026-03-02" }),
    "The close date must be on or after the open date.",
  );
});

test("stored instants render back as the event-local calendar dates that were typed", () => {
  assert.equal(
    formatRoundWindow("2026-03-02T08:00:00.000Z", "2026-03-21T06:59:00.000Z", LOS_ANGELES),
    "Opens Mar 2, 2026 · Closes Mar 20, 2026",
  );
  assert.equal(
    formatRoundWindow("2026-03-02T08:00:00.000Z", null, LOS_ANGELES),
    "Opens Mar 2, 2026",
  );
  assert.equal(
    formatRoundWindow(null, "2026-03-21T06:59:00.000Z", LOS_ANGELES),
    "Closes Mar 20, 2026",
  );
});

test("the label renders in the event timezone rather than the runtime timezone", () => {
  // The same instant is still 20 March in Los Angeles and already 21 March in
  // Tokyo; the round list must print the event's own calendar date.
  assert.equal(
    formatRoundWindow(null, "2026-03-21T06:59:00.000Z", "Asia/Tokyo"),
    "Closes Mar 21, 2026",
  );
});

test("an inverted stored window names both bounds instead of collapsing to one date", () => {
  // formatEventDateRange prints only the start when the end precedes it, which
  // would hide a window written by a direct API call. Both bounds stay visible.
  assert.equal(
    formatRoundWindow("2026-03-20T07:00:00.000Z", "2026-03-02T08:00:00.000Z", LOS_ANGELES),
    "Opens Mar 20, 2026 · Closes Mar 2, 2026",
  );
});

test("an unparseable stored bound is dropped rather than rendered as Invalid Date", () => {
  assert.equal(formatRoundWindow("not-a-date", null, LOS_ANGELES), null);
  assert.equal(
    formatRoundWindow("2026-03-02T08:00:00.000Z", "not-a-date", LOS_ANGELES),
    "Opens Mar 2, 2026",
  );
});
