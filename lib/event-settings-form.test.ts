import assert from "node:assert/strict";
import { test } from "node:test";
import {
  eventSettingsDraft,
  planCategoryPatch,
  planEventSettingsPatch,
  planTrackPatch,
  reconcileEventSettingsDraft,
  validateEventDatePair,
} from "./event-settings-form";

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

// ---- Taxonomy row editors -------------------------------------------------

const loadedCategory = {
  name: "AI & Machine Learning",
  description: "Applied ML and model work.",
  defaultTeamKey: "team-ai",
};

const categoryDraft = {
  name: loadedCategory.name,
  description: loadedCategory.description ?? "",
  defaultTeamKey: loadedCategory.defaultTeamKey ?? "",
};

test("a rename-only category edit sends the name and nothing else", () => {
  const patch = planCategoryPatch({ ...categoryDraft, name: "AI & ML" }, loadedCategory);
  assert.deepEqual(patch, { name: "AI & ML" });
  // Absence, not equality: a key carrying the loaded value would still be a
  // write, and the whole point is that this request must not write these.
  assert.equal(patch !== null && "defaultTeamKey" in patch, false);
  assert.equal(patch !== null && "description" in patch, false);
});

test("a rename cannot revert a routing key another admin changed while the editor was open", () => {
  // The editor loaded team-ai and never touched the field. Meanwhile another
  // admin moved this category to team-ml. Diffing against the loaded snapshot
  // omits the field entirely, so the rename lands and team-ml survives.
  const patch = planCategoryPatch({ ...categoryDraft, name: "AI & ML" }, loadedCategory);
  assert.equal(patch !== null && "defaultTeamKey" in patch, false);

  // Whereas an operator who did edit the routing key still wins on that field.
  const deliberate = planCategoryPatch({ ...categoryDraft, defaultTeamKey: "team-platform" }, loadedCategory);
  assert.deepEqual(deliberate, { defaultTeamKey: "team-platform" });
});

test("clearing an optional category field is an explicit null, not an omission", () => {
  assert.deepEqual(planCategoryPatch({ ...categoryDraft, description: "" }, loadedCategory), { description: null });
  assert.deepEqual(planCategoryPatch({ ...categoryDraft, defaultTeamKey: "   " }, loadedCategory), { defaultTeamKey: null });
  // A field that was already empty and stayed empty is not a change.
  assert.equal(
    planCategoryPatch(
      { name: "Keynotes", description: "", defaultTeamKey: "" },
      { name: "Keynotes", description: null, defaultTeamKey: null },
    ),
    null,
  );
});

test("an untouched category edit plans no request at all", () => {
  assert.equal(planCategoryPatch(categoryDraft, loadedCategory), null);
  // Whitespace-only differences are not edits either.
  assert.equal(planCategoryPatch({ ...categoryDraft, name: "  AI & Machine Learning  " }, loadedCategory), null);
});

test("a track rename omits the colour, so a concurrent recolour survives", () => {
  const loaded = { name: "Mainstage", color: "#6366f1" };
  const draft = { name: "Main Stage", color: "#6366f1" };
  assert.deepEqual(planTrackPatch(draft, loaded), { name: "Main Stage" });
  assert.equal("color" in planTrackPatch(draft, loaded)!, false);
});

test("track colour comparison uses the form the colour input actually shows", () => {
  // Stored `#abc` expands to `#aabbcc` in the editor. That is the same colour,
  // so an untouched swatch must not plan a write.
  assert.equal(planTrackPatch({ name: "Workshops", color: "#aabbcc" }, { name: "Workshops", color: "abc" }), null);
  assert.deepEqual(
    planTrackPatch({ name: "Workshops", color: "#0ea5e9" }, { name: "Workshops", color: "abc" }),
    { color: "#0ea5e9" },
  );
  // An unreadable stored colour is not equal to a real one the editor is
  // showing, so saving persists what the operator actually saw.
  assert.deepEqual(
    planTrackPatch({ name: "Workshops", color: "#6366f1" }, { name: "Workshops", color: "rebeccapurple" }),
    { color: "#6366f1" },
  );
});

test("an untouched track edit plans no request at all", () => {
  assert.equal(planTrackPatch({ name: "Mainstage", color: "#6366f1" }, { name: "Mainstage", color: "#6366f1" }), null);
});
