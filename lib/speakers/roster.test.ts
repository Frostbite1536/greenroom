import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SPEAKER_SEARCH_MAX_LENGTH,
  filterSpeakerRosterRows,
  matchesSpeakerQuery,
  parseSpeakerQuery,
  speakerProvisionNotice,
  speakerRosterHref,
} from "./roster";
import { buildSpeakerRosterRows, type SpeakerRosterMember, type SpeakerStatusRow } from "./status";

function member(overrides: Partial<SpeakerRosterMember> = {}): SpeakerRosterMember {
  return {
    userId: "user-1",
    name: "Nadia Okonkwo",
    email: "nadia@northwind.test",
    profile: {
      bio: "Keeps large event systems online under load.",
      company: "Northwind",
      jobTitle: "Principal Engineer",
      headshotUrl: "https://images.test/nadia.jpg",
    },
    ...overrides,
  };
}

function rowFor(overrides: Partial<SpeakerRosterMember> = {}): SpeakerStatusRow {
  const [row] = buildSpeakerRosterRows([member(overrides)], [], []);
  return row;
}

test("parseSpeakerQuery trims, tolerates absence, and bounds a hostile URL", () => {
  assert.equal(parseSpeakerQuery(undefined), "");
  assert.equal(parseSpeakerQuery("   "), "");
  assert.equal(parseSpeakerQuery("  Nadia  "), "Nadia");
  const long = "x".repeat(SPEAKER_SEARCH_MAX_LENGTH + 50);
  assert.equal(parseSpeakerQuery(long).length, SPEAKER_SEARCH_MAX_LENGTH);
});

test("search matches every stored field an operator would remember, case-insensitively", () => {
  const row = rowFor();
  for (const query of ["nadia", "OKONKWO", "northwind", "principal", "online under load", "@northwind.test"]) {
    assert.equal(matchesSpeakerQuery(row, query), true, `expected "${query}" to match`);
  }
  assert.equal(matchesSpeakerQuery(row, "westwind"), false);
});

test("search matches a session title the speaker is actually on", () => {
  const [row] = buildSpeakerRosterRows(
    [member()],
    [{
      userId: "user-1",
      name: "Nadia Okonkwo",
      email: "nadia@northwind.test",
      profile: null,
      sessionId: "session-1",
      sessionTitle: "Incident review culture",
      scheduled: true,
    }],
    [],
  );
  assert.equal(matchesSpeakerQuery(row, "incident"), true);
  assert.equal(matchesSpeakerQuery(row, "keynote"), false);
});

test("every term must match, so a second word narrows rather than widens", () => {
  const nadia = rowFor();
  const otherNorthwind = rowFor({
    userId: "user-2",
    name: "Theo Lindqvist",
    email: "theo@northwind.test",
    profile: { company: "Northwind", bio: null, jobTitle: null, headshotUrl: null },
  });
  assert.equal(matchesSpeakerQuery(nadia, "nadia northwind"), true);
  assert.equal(matchesSpeakerQuery(otherNorthwind, "nadia northwind"), false);
  // Extra whitespace between terms is not a term of its own.
  assert.equal(matchesSpeakerQuery(nadia, "  nadia   northwind  ".trim()), true);
});

test("an absent field is never matched by a search for it", () => {
  const bare = rowFor({
    userId: "user-3",
    name: "Sam Reed",
    email: "sam@example.test",
    profile: null,
  });
  assert.equal(bare.bio, null);
  assert.equal(bare.company, null);
  assert.equal(matchesSpeakerQuery(bare, "northwind"), false);
  // The empty query is not a match-nothing: it is the unfiltered roster.
  assert.equal(matchesSpeakerQuery(bare, ""), true);
});

test("filterSpeakerRosterRows narrows the roster and returns it whole when unsearched", () => {
  const rows = buildSpeakerRosterRows(
    [
      member(),
      member({ userId: "user-2", name: "Theo Lindqvist", email: "theo@example.test", profile: null }),
    ],
    [],
    [],
  );
  assert.equal(rows.length, 2);
  assert.equal(filterSpeakerRosterRows(rows, "").length, 2);
  const narrowed = filterSpeakerRosterRows(rows, "northwind");
  assert.deepEqual(narrowed.map((row) => row.userId), ["user-1"]);
});

test("roster links carry both the filter and the active search", () => {
  assert.equal(speakerRosterHref({ filter: "all", query: "" }), "/admin/speakers");
  assert.equal(speakerRosterHref({ filter: "unscheduled", query: "" }), "/admin/speakers?filter=unscheduled");
  assert.equal(speakerRosterHref({ filter: "all", query: "nadia" }), "/admin/speakers?q=nadia");
  assert.equal(
    speakerRosterHref({ filter: "incomplete-profile", query: "nadia okonkwo" }),
    "/admin/speakers?filter=incomplete-profile&q=nadia+okonkwo",
  );
  // A query that would otherwise break the URL is encoded, not dropped.
  assert.equal(speakerRosterHref({ filter: "all", query: "a&b=c" }), "/admin/speakers?q=a%26b%3Dc");
});

test("provisioning a brand-new speaker reads as a plain addition", () => {
  assert.equal(
    speakerProvisionNotice({
      name: "Nadia Okonkwo",
      email: "nadia@northwind.test",
      requestedName: "Nadia Okonkwo",
      userCreated: true,
      membershipCreated: true,
    }),
    "Added Nadia Okonkwo (nadia@northwind.test) to this event as a speaker.",
  );
});

test("a reused account says so, and says plainly which name was kept", () => {
  const notice = speakerProvisionNotice({
    name: "Nadia Okonkwo",
    email: "nadia@northwind.test",
    requestedName: "N. Okonkwo",
    userCreated: false,
    membershipCreated: true,
  });
  assert.match(notice, /already had an account, so it was reused/);
  assert.match(notice, /saved name “Nadia Okonkwo” was kept rather than replaced with “N\. Okonkwo”/);
});

test("re-adding an existing speaker reports the no-op instead of implying a change", () => {
  const notice = speakerProvisionNotice({
    name: "Nadia Okonkwo",
    email: "nadia@northwind.test",
    requestedName: "  Nadia Okonkwo  ",
    userCreated: false,
    membershipCreated: false,
  });
  assert.match(notice, /already a speaker on this event, so nothing was duplicated/);
  // The typed name only differed by whitespace, so there is no name to report.
  assert.doesNotMatch(notice, /was kept rather than replaced/);
});
