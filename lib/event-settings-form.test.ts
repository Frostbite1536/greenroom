import assert from "node:assert/strict";
import { test } from "node:test";
import { validateEventDatePair } from "./event-settings-form";

test("event dates must be entered or cleared as a pair", () => {
  assert.equal(validateEventDatePair("2026-05-12", ""), "Enter both event dates, or clear both dates together.");
  assert.equal(validateEventDatePair("", "2026-05-14"), "Enter both event dates, or clear both dates together.");
  assert.equal(validateEventDatePair("", ""), null);
});

test("event end date cannot precede the start", () => {
  assert.equal(validateEventDatePair("2026-05-14", "2026-05-12"), "The event must end on or after its start date.");
  assert.equal(validateEventDatePair("2026-05-12", "2026-05-14"), null);
});
