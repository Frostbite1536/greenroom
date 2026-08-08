import assert from "node:assert/strict";
import { test } from "node:test";
import { zonedToUtcIso } from "./tz";

const LOS_ANGELES = "America/Los_Angeles";

test("converts the seeded Los Angeles event boundary and agenda time to UTC", () => {
  assert.equal(zonedToUtcIso("2026-05-12", "00:00", LOS_ANGELES), "2026-05-12T07:00:00.000Z");
  assert.equal(zonedToUtcIso("2026-05-12", "09:00", LOS_ANGELES), "2026-05-12T16:00:00.000Z");
});

test("uses the daylight-saving offset after Los Angeles spring-forward", () => {
  assert.equal(zonedToUtcIso("2026-03-08", "09:00", LOS_ANGELES), "2026-03-08T16:00:00.000Z");
});
