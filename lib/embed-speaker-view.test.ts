import assert from "node:assert/strict";
import test from "node:test";
import {
  headshotAlt,
  initials,
  sessionPlacementLine,
  speakerCredit,
  speakerDetailLine,
  speakerHeadline,
  type SpeakerViewProfile,
  type SpeakerViewSession,
} from "./embed-speaker-view";

const LOS_ANGELES = "America/Los_Angeles";

function speaker(overrides: Partial<SpeakerViewProfile> = {}): SpeakerViewProfile {
  return {
    name: "Elena Rodriguez",
    bio: "Builds reliable systems.",
    company: "CloudScale",
    jobTitle: "Principal Engineer",
    headshotUrl: "https://images.example.test/elena.jpg",
    sessions: [],
    ...overrides,
  };
}

function session(overrides: Partial<SpeakerViewSession> = {}): SpeakerViewSession {
  return {
    id: "session-1",
    title: "Scaling to 10M",
    track: { name: "Engineering" },
    startsAt: "2026-05-12T17:00:00.000Z",
    endsAt: "2026-05-12T17:45:00.000Z",
    room: "Redwood Hall",
    ...overrides,
  };
}

test("the headline uses whichever of title and employer is stored", () => {
  assert.equal(speakerHeadline(speaker()), "Principal Engineer at CloudScale");
  assert.equal(speakerHeadline(speaker({ company: null })), "Principal Engineer");
  assert.equal(speakerHeadline(speaker({ jobTitle: null })), "CloudScale");
  assert.equal(speakerHeadline(speaker({ jobTitle: null, company: null })), null);
  // Whitespace-only storage is absence, not a role.
  assert.equal(speakerHeadline(speaker({ jobTitle: "  ", company: "  " })), null);
});

test("a speaker with no title or employer falls back to their own programme, not filler", () => {
  const withoutProfile = speaker({
    jobTitle: null,
    company: null,
    sessions: [session(), session({ id: "session-2", track: { name: "Design" } })],
  });
  assert.equal(speakerDetailLine(withoutProfile), "2 sessions · Engineering, Design");

  // A different speaker with an equally empty profile reads differently, which
  // is the point: the old behaviour printed one identical placeholder for both.
  const other = speaker({
    name: "Sofia Marques",
    jobTitle: null,
    company: null,
    sessions: [session({ id: "session-3", track: { name: "Product" } })],
  });
  assert.equal(speakerDetailLine(other), "1 session · Product");
  assert.notEqual(speakerDetailLine(withoutProfile), speakerDetailLine(other));
});

test("the derived credit degrades cleanly with no tracks and summarises many", () => {
  assert.equal(speakerCredit({ sessions: [session({ track: null })] }), "1 session");
  assert.equal(speakerCredit({ sessions: [] }), null);
  const many = ["A", "B", "C", "D"].map((name, index) => session({ id: `s-${index}`, track: { name } }));
  assert.equal(speakerCredit({ sessions: many }), "4 sessions · A, B +2 more");
  // Duplicate tracks collapse rather than repeating.
  assert.equal(
    speakerCredit({ sessions: [session(), session({ id: "s-2" })] }),
    "2 sessions · Engineering",
  );
});

test("a stored profile always wins over the derived credit", () => {
  assert.equal(speakerDetailLine(speaker({ sessions: [session()] })), "Principal Engineer at CloudScale");
});

test("the session line names day, time and room in the event timezone", () => {
  assert.equal(sessionPlacementLine(session(), LOS_ANGELES), "Tue, May 12 · 10:00 AM–10:45 AM · Redwood Hall");
});

test("the session line omits what is missing instead of inventing it", () => {
  assert.equal(sessionPlacementLine(session({ room: null }), LOS_ANGELES), "Tue, May 12 · 10:00 AM–10:45 AM");
  assert.equal(sessionPlacementLine(session({ endsAt: null }), LOS_ANGELES), "Tue, May 12 · 10:00 AM · Redwood Hall");
  assert.equal(sessionPlacementLine(session({ startsAt: null, endsAt: null }), LOS_ANGELES), "Redwood Hall");
  assert.equal(sessionPlacementLine(session({ startsAt: null, endsAt: null, room: null }), LOS_ANGELES), null);
  // Corrupt stored instants must not throw on a public page.
  assert.equal(sessionPlacementLine(session({ startsAt: "not-a-date", room: null }), LOS_ANGELES), null);
});

test("a headshot names who is pictured and initials cover its absence", () => {
  assert.equal(headshotAlt("Elena Rodriguez"), "Headshot of Elena Rodriguez");
  assert.equal(initials("Elena Rodriguez"), "ER");
  assert.equal(initials("Prince"), "P");
  assert.equal(initials("  ada   lovelace  king "), "AL");
});
