import assert from "node:assert/strict";
import { test } from "node:test";
import { formatEventDateTime, zonedParts, zonedToUtcIso } from "./tz";

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
