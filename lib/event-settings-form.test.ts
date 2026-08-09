import assert from "node:assert/strict";
import { test } from "node:test";
import { planEventSettingsPatch, validateEventDatePair } from "./event-settings-form";

const authoritative = {
  name: "Forward 2026",
  timezone: "America/Chicago",
  startsOn: "2026-05-12",
  endsOn: "2026-05-14",
};

test("event dates must be entered or cleared as a pair", () => {
  assert.equal(validateEventDatePair("2026-05-12", ""), "Enter both event dates, or clear both dates together.");
  assert.equal(validateEventDatePair("", "2026-05-14"), "Enter both event dates, or clear both dates together.");
  assert.equal(validateEventDatePair("", ""), null);
});

test("event end date cannot precede the start", () => {
  assert.equal(validateEventDatePair("2026-05-14", "2026-05-12"), "The event must end on or after its start date.");
  assert.equal(validateEventDatePair("2026-05-12", "2026-05-14"), null);
});

test("event settings PATCH omits untouched fields", () => {
  assert.equal(planEventSettingsPatch({ ...authoritative }, authoritative), null);
  assert.deepEqual(
    planEventSettingsPatch({ ...authoritative, name: "Forward Conference" }, authoritative),
    { name: "Forward Conference" },
  );
  assert.deepEqual(
    planEventSettingsPatch({ ...authoritative, timezone: "America/New_York" }, authoritative),
    { timezone: "America/New_York" },
  );
});

test("event settings PATCH always sends dates as a pair", () => {
  assert.deepEqual(
    planEventSettingsPatch({ ...authoritative, endsOn: "2026-05-15" }, authoritative),
    { startsOn: "2026-05-12", endsOn: "2026-05-15" },
  );
  assert.deepEqual(
    planEventSettingsPatch({ ...authoritative, startsOn: "", endsOn: "" }, authoritative),
    { startsOn: null, endsOn: null },
  );
});
