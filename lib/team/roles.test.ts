import assert from "node:assert/strict";
import test from "node:test";
import {
  TEAM_ADDABLE_ROLES,
  TEAM_ASSIGNABLE_ROLES,
  TEAM_EXISTING_ACCOUNT_NOTE,
  TEAM_ROLE_DESCRIPTIONS,
  TEAM_ROLE_LABELS,
  compareTeamMembers,
  teamAddNotice,
  teamDialogRecovery,
  teamRolePhrase,
  type TeamMember,
} from "@/lib/team/roles";

function member(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    userId: "u1",
    name: "Ada",
    email: "ada@example.com",
    role: "ADMIN",
    joinedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

test("the members list is ordered by authority, then name, then id", () => {
  const rows: TeamMember[] = [
    member({ userId: "u4", name: "Zoe", role: "SPEAKER" }),
    member({ userId: "u3", name: "Bo", role: "EVALUATOR" }),
    member({ userId: "u2", name: "Ada", role: "EVALUATOR" }),
    member({ userId: "u1", name: "Cy", role: "ADMIN" }),
  ];
  assert.deepEqual([...rows].sort(compareTeamMembers).map((row) => row.userId), ["u1", "u2", "u3", "u4"]);
});

test("the order is total and stable — equal name and role fall through to the id", () => {
  const left = member({ userId: "a", name: "Same", role: "EVALUATOR" });
  const right = member({ userId: "b", name: "Same", role: "EVALUATOR" });
  assert.ok(compareTeamMembers(left, right) < 0);
  assert.ok(compareTeamMembers(right, left) > 0);
  assert.equal(compareTeamMembers(left, { ...left }), 0);
});

test("names are compared by codepoint, so two servers in different locales render one order", () => {
  // A locale-collated comparison sorts "a" before "B"; a codepoint one does not.
  const upper = member({ userId: "x", name: "Bea", role: "ADMIN" });
  const lower = member({ userId: "y", name: "adam", role: "ADMIN" });
  assert.ok(compareTeamMembers(upper, lower) < 0);
});

test("every role a member can hold has a label and a description", () => {
  for (const role of ["ADMIN", "EVALUATOR", "SPEAKER"] as const) {
    assert.equal(typeof TEAM_ROLE_LABELS[role], "string");
    assert.ok(TEAM_ROLE_LABELS[role].length > 0);
    assert.ok(TEAM_ROLE_DESCRIPTIONS[role].length > 0);
  }
  // Speakers are provisioned by /admin/speakers, which writes their profile too;
  // they are still assignable as an existing member's role.
  assert.deepEqual([...TEAM_ADDABLE_ROLES], ["ADMIN", "EVALUATOR"]);
  assert.deepEqual([...TEAM_ASSIGNABLE_ROLES], ["ADMIN", "EVALUATOR", "SPEAKER"]);
  assert.ok(!TEAM_ADDABLE_ROLES.includes("SPEAKER" as never));
});

test("the role phrase carries its own article, so no notice reads 'a organizer'", () => {
  assert.equal(teamRolePhrase("ADMIN"), "an organizer");
  assert.equal(teamRolePhrase("EVALUATOR"), "a reviewer");
  assert.equal(teamRolePhrase("SPEAKER"), "a speaker");
});

test("re-adding somebody who is already on the event says nothing changed", () => {
  const notice = teamAddNotice({
    name: "Ada", email: "ada@example.com", role: "EVALUATOR", membershipCreated: false,
  });
  assert.match(notice, /already a reviewer on this event/);
  assert.match(notice, /Nothing changed/);
});

test("a successful add reports the resolved account's stored name and address", () => {
  const notice = teamAddNotice({
    name: "Ada Lovelace", email: "ada@example.com", role: "ADMIN", membershipCreated: true,
  });
  assert.match(notice, /Ada Lovelace \(ada@example\.com\) is now an organizer on this event/);
  assert.match(notice, /next time they sign in/);
  // The name is the stored one — the form never asked for one — so this line is
  // also how the organizer confirms the address matched the person they meant.
  // Nothing here may claim mail was sent, because none is.
  assert.doesNotMatch(notice, /check (your|their) inbox/i);
  assert.doesNotMatch(notice, /we (have )?(sent|emailed)/i);
});

test("no add notice can ever describe having created an account", () => {
  // The route refuses an unknown address rather than provisioning a shell, so
  // there is no third branch here to say "created an account for…". If one is
  // ever reintroduced, this catches it.
  for (const membershipCreated of [true, false]) {
    const notice = teamAddNotice({
      name: "Ada", email: "ada@example.com", role: "EVALUATOR", membershipCreated,
    });
    assert.doesNotMatch(notice, /created an account/i);
    assert.doesNotMatch(notice, /no password/i);
  }
});

test("the add dialog's standing note says an account is required, before anyone types", () => {
  // Stated up front rather than only when the server refuses: the organizer
  // should learn the constraint while composing, not after a rejection.
  assert.match(TEAM_EXISTING_ACCOUNT_NOTE, /must already have a Greenroom account/);
  assert.match(TEAM_EXISTING_ACCOUNT_NOTE, /only mails accounts that already have "?one/);
  assert.match(TEAM_EXISTING_ACCOUNT_NOTE, /sign up at \/signup first/);
  assert.doesNotMatch(TEAM_EXISTING_ACCOUNT_NOTE, /we (have )?(sent|emailed)/i);
});

test("a dialog that throws still says nothing was changed", () => {
  for (const action of ["add", "save", "remove"] as const) {
    assert.match(teamDialogRecovery(action), /Nothing was changed/);
  }
});
