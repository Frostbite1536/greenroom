import assert from "node:assert/strict";
import test from "node:test";
import { coSpeakerSummary, proposalRosterLine, proposalSpeakerLabel } from "./proposal-roster";

const elena = { name: "Elena Rodriguez", isPrimary: true, role: null };
const marcus = { name: "Marcus Chen", isPrimary: false, role: "Co-presenter" };

test("a stated role is shown alongside the primary marker, never instead of it", () => {
  assert.equal(
    proposalSpeakerLabel({ name: "Elena Rodriguez", isPrimary: true, role: "Presenter" }),
    "Elena Rodriguez (primary) — Presenter",
  );
  assert.equal(proposalSpeakerLabel(elena), "Elena Rodriguez (primary)");
  assert.equal(proposalSpeakerLabel(marcus), "Marcus Chen — Co-presenter");
});

test("an unstated or blank role adds nothing rather than an empty dash", () => {
  assert.equal(proposalSpeakerLabel({ name: "Marcus Chen", isPrimary: false }), "Marcus Chen");
  assert.equal(proposalSpeakerLabel({ name: "Marcus Chen", isPrimary: false, role: "   " }), "Marcus Chen");
});

test("the roster line keeps the submitter's own order", () => {
  assert.equal(
    proposalRosterLine([elena, marcus]),
    "Elena Rodriguez (primary), Marcus Chen — Co-presenter",
  );
  assert.equal(proposalRosterLine([marcus, elena]).startsWith("Marcus Chen"), true);
});

test("a proposal with no speakers reads as an honest absence", () => {
  assert.equal(proposalRosterLine([]), "—");
});

test("a lone speaker has no co-speaker summary at all", () => {
  assert.equal(coSpeakerSummary([elena]), null);
  assert.equal(coSpeakerSummary([]), null);
});

test("distinct stated roles are named in the table summary", () => {
  assert.equal(
    coSpeakerSummary([elena, marcus, { name: "Priya Nair", isPrimary: false, role: "Panellist" }]),
    "+2 co-speakers: Co-presenter, Panellist",
  );
  assert.equal(coSpeakerSummary([elena, marcus]), "+1 co-speaker: Co-presenter");
});

test("repeated or partial roles fall back to a plain count", () => {
  // Three identical labels tell an organizer less than the count does.
  assert.equal(
    coSpeakerSummary([elena, marcus, { name: "Priya Nair", isPrimary: false, role: "Co-presenter" }]),
    "+2 co-speakers",
  );
  // One stated and one not is not a described line-up either.
  assert.equal(
    coSpeakerSummary([elena, marcus, { name: "Priya Nair", isPrimary: false, role: null }]),
    "+2 co-speakers",
  );
});

test("a roster with no primary still describes everyone after the first", () => {
  assert.equal(
    coSpeakerSummary([
      { name: "Marcus Chen", isPrimary: false, role: "Co-presenter" },
      { name: "Priya Nair", isPrimary: false, role: "Panellist" },
    ]),
    "+1 co-speaker: Panellist",
  );
});
