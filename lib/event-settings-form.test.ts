import assert from "node:assert/strict";
import { test } from "node:test";
import { eventSettingsDraft, planEventSettingsPatch, reconcileEventSettingsDraft, validateEventDatePair } from "./event-settings-form";

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

test("settings refresh adopts server truth only for fields this editor did not change", () => {
  const baseline = eventSettingsDraft(authoritative);
  const reconciliation = reconcileEventSettingsDraft(
    baseline,
    { ...baseline, name: "Local programme name" },
    {
      name: "Another admin's name",
      timezone: "America/New_York",
      startsOn: "2026-05-13",
      endsOn: "2026-05-15",
    },
  );

  assert.deepEqual(reconciliation.baseline, {
    name: "Another admin's name",
    timezone: "America/New_York",
    startsOn: "2026-05-13",
    endsOn: "2026-05-15",
  });
  assert.deepEqual(reconciliation.draft, {
    name: "Local programme name",
    timezone: "America/New_York",
    startsOn: "2026-05-13",
    endsOn: "2026-05-15",
  });
});

test("settings reconciliation keeps a keystroke made after the submitted snapshot", () => {
  const baseline = eventSettingsDraft(authoritative);
  const submitted = { ...baseline, name: "Submitted name" };
  const response = {
    ...authoritative,
    name: "Submitted name",
  };
  const reconciliation = reconcileEventSettingsDraft(
    baseline,
    { ...baseline, name: "Newer unsaved name" },
    response,
    submitted,
  );

  assert.deepEqual(reconciliation.draft, { ...baseline, name: "Newer unsaved name" });
  assert.deepEqual(reconciliation.baseline, eventSettingsDraft(response));
});

test("a successful save adopts server normalization when no newer edit exists", () => {
  const baseline = eventSettingsDraft(authoritative);
  const submitted = { ...baseline, name: "  Forward Conference  " };
  const response = { ...authoritative, name: "Forward Conference" };
  const reconciliation = reconcileEventSettingsDraft(baseline, submitted, response, submitted);

  assert.equal(reconciliation.draft.name, "Forward Conference");
  assert.equal(planEventSettingsPatch(reconciliation.draft, reconciliation.baseline), null);
});

test("an unrelated room or category refresh leaves a dirty event draft intact", () => {
  const baseline = eventSettingsDraft(authoritative);
  const draft = { ...baseline, timezone: "Europe/London" };
  assert.deepEqual(reconcileEventSettingsDraft(baseline, draft, authoritative).draft, draft);
});
