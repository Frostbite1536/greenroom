import assert from "node:assert/strict";
import test from "node:test";
import type { UserRole } from "@prisma/client";
import {
  EVALUATOR_HAS_ASSIGNMENTS,
  LAST_ADMIN,
  NO_ACCOUNT_FOR_EMAIL,
  NO_ACCOUNT_FOR_EMAIL_MESSAGE,
  SPEAKER_HAS_PROGRAMME_WORK,
  TEAM_BLOCKING_ASSIGNMENT_STATUSES,
  decideMemberRemoval,
  decideRoleChange,
  eventTeamAddSchema,
  eventTeamLockKey,
  eventTeamRoleChangeSchema,
  roleCanHoldAssignments,
  type RemovalFacts,
  type RoleChangeFacts,
} from "@/lib/services/event-team";

/**
 * The team guards as pure decisions. Everything the route learns from the
 * database arrives here as a number, so every refusal — and every case that
 * must NOT refuse — is observable without one.
 */

function roleChange(overrides: Partial<RoleChangeFacts> = {}): RoleChangeFacts {
  return {
    current: "EVALUATOR",
    next: "SPEAKER",
    adminCount: 2,
    activeAssignments: 0,
    self: false,
    ...overrides,
  };
}

function removal(overrides: Partial<RemovalFacts> = {}): RemovalFacts {
  return {
    role: "EVALUATOR",
    adminCount: 2,
    activeAssignments: 0,
    sessionCount: 0,
    taskCount: 0,
    self: false,
    ...overrides,
  };
}

/* ---------------- last organizer ---------------- */

test("the last organizer cannot be demoted to any other role", () => {
  for (const next of ["EVALUATOR", "SPEAKER"] as UserRole[]) {
    const decision = decideRoleChange(roleChange({ current: "ADMIN", next, adminCount: 1 }));
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, LAST_ADMIN);
  }
});

test("the caller demoting THEMSELF out of the last organizer seat is the same refusal, said to them", () => {
  const decision = decideRoleChange(
    roleChange({ current: "ADMIN", next: "EVALUATOR", adminCount: 1, self: true }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowed === false && decision.code, LAST_ADMIN);
  // Second person, because the person reading it is the one who would be locked
  // out. The other-person wording would read as a refusal about somebody else.
  assert.match(decision.allowed === false ? decision.message : "", /You are the only organizer/);
  assert.match(decision.allowed === false ? decision.message : "", /if you step down now/);
});

test("a second organizer is what unblocks both the demotion and the removal", () => {
  assert.equal(decideRoleChange(roleChange({ current: "ADMIN", next: "EVALUATOR", adminCount: 2 })).allowed, true);
  assert.equal(decideMemberRemoval(removal({ role: "ADMIN", adminCount: 2 })).allowed, true);
});

test("the last organizer cannot be removed either, by anyone including themself", () => {
  for (const self of [false, true]) {
    const decision = decideMemberRemoval(removal({ role: "ADMIN", adminCount: 1, self }));
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, LAST_ADMIN);
  }
  const other = decideMemberRemoval(removal({ role: "ADMIN", adminCount: 1, self: false }));
  assert.match(other.allowed === false ? other.message : "", /This is the only organizer/);
});

test("a no-op role change is never refused, even for the only organizer", () => {
  // The route short-circuits an unchanged role, but the decision must agree:
  // re-sending ADMIN for the sole ADMIN is not a demotion.
  assert.equal(decideRoleChange(roleChange({ current: "ADMIN", next: "ADMIN", adminCount: 1 })).allowed, true);
});

test("an organizer count of zero is refused as hard as one — never read as 'nothing to lose'", () => {
  // A `<= 1` bound rather than `=== 1`: a corrupt or racing read of 0 must not
  // become the one input that lets the rule pass.
  const decision = decideMemberRemoval(removal({ role: "ADMIN", adminCount: 0 }));
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowed === false && decision.code, LAST_ADMIN);
});

/* ---------------- open review assignments ---------------- */

test("only ASSIGNED and IN_PROGRESS block; finished and declined review work does not", () => {
  assert.deepEqual([...TEAM_BLOCKING_ASSIGNMENT_STATUSES], ["ASSIGNED", "IN_PROGRESS"]);
  assert.ok(!TEAM_BLOCKING_ASSIGNMENT_STATUSES.includes("COMPLETED" as never));
  assert.ok(!TEAM_BLOCKING_ASSIGNMENT_STATUSES.includes("DECLINED" as never));
});

test("a reviewer with open assignments cannot be demoted to speaker, and the count is named", () => {
  const decision = decideRoleChange(
    roleChange({ current: "EVALUATOR", next: "SPEAKER", activeAssignments: 4 }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowed === false && decision.code, EVALUATOR_HAS_ASSIGNMENTS);
  assert.match(decision.allowed === false ? decision.message : "", /4 proposals are still assigned/);
  assert.match(decision.allowed === false ? decision.message : "", /Reassign them from Evaluations/);
});

test("a reviewer with open assignments cannot be removed, and the count is named", () => {
  const decision = decideMemberRemoval(removal({ role: "EVALUATOR", activeAssignments: 1 }));
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowed === false && decision.code, EVALUATOR_HAS_ASSIGNMENTS);
  // Singular, because "1 proposals are" would be the refusal contradicting the
  // number it just printed.
  assert.match(decision.allowed === false ? decision.message : "", /1 proposal is still assigned/);
  assert.match(decision.allowed === false ? decision.message : "", /Reassign it .*then remove them/);
});

test("promoting a reviewer to organizer keeps their queue valid and is never refused for it", () => {
  // ADMIN can hold assignments (`isAssignmentEvaluatorRole`), so nothing is
  // stranded. Refusing here would make the safest promotion the hardest one.
  assert.equal(roleCanHoldAssignments("ADMIN"), true);
  assert.equal(roleCanHoldAssignments("EVALUATOR"), true);
  assert.equal(roleCanHoldAssignments("SPEAKER"), false);
  assert.equal(
    decideRoleChange(roleChange({ current: "EVALUATOR", next: "ADMIN", activeAssignments: 9 })).allowed,
    true,
  );
});

test("an organizer who holds review work is caught by the same rule when demoted to speaker", () => {
  const decision = decideRoleChange(
    roleChange({ current: "ADMIN", next: "SPEAKER", adminCount: 3, activeAssignments: 2 }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowed === false && decision.code, EVALUATOR_HAS_ASSIGNMENTS);
});

test("when both rules apply the last-organizer one is reported, because it is the one with no workaround", () => {
  const decision = decideRoleChange(
    roleChange({ current: "ADMIN", next: "SPEAKER", adminCount: 1, activeAssignments: 5 }),
  );
  assert.equal(decision.allowed === false && decision.code, LAST_ADMIN);
});

/* ---------------- speakers with programme work ---------------- */

test("a speaker with sessions or tasks is not removable, and what is in the way is named", () => {
  const sessions = decideMemberRemoval(removal({ role: "SPEAKER", sessionCount: 2 }));
  assert.equal(sessions.allowed === false && sessions.code, SPEAKER_HAS_PROGRAMME_WORK);
  assert.match(sessions.allowed === false ? sessions.message : "", /2 sessions on this event/);

  const tasks = decideMemberRemoval(removal({ role: "SPEAKER", taskCount: 1 }));
  assert.match(tasks.allowed === false ? tasks.message : "", /1 onboarding task on this event/);

  const both = decideMemberRemoval(removal({ role: "SPEAKER", sessionCount: 1, taskCount: 3 }));
  assert.match(both.allowed === false ? both.message : "", /1 session and 3 onboarding tasks/);
  // The reason, not just the refusal: deleting the membership would leave them
  // on the programme anyway, which is why this is refused rather than cascaded.
  assert.match(both.allowed === false ? both.message : "", /would not take them off the programme/);
});

test("a speaker with nothing on the programme is removable", () => {
  assert.equal(decideMemberRemoval(removal({ role: "SPEAKER" })).allowed, true);
});

test("programme work never blocks a role CHANGE — nothing is deleted by one", () => {
  // Sessions and tasks are keyed on the user, not the membership role, so they
  // survive a re-role intact. Refusing would trap a speaker who became staff.
  assert.equal(
    decideRoleChange(roleChange({ current: "SPEAKER", next: "EVALUATOR" })).allowed,
    true,
  );
  assert.equal(
    decideRoleChange(roleChange({ current: "SPEAKER", next: "ADMIN" })).allowed,
    true,
  );
});

test("programme work does not block removing an organizer or a reviewer", () => {
  // The rule is about the speaker roster's union read; it must not leak into
  // roles that roster does not describe.
  assert.equal(decideMemberRemoval(removal({ role: "EVALUATOR", sessionCount: 4, taskCount: 4 })).allowed, true);
  assert.equal(decideMemberRemoval(removal({ role: "ADMIN", sessionCount: 4, taskCount: 4 })).allowed, true);
});

/* ---------------- contracts ---------------- */

test("the add contract grants organizer or reviewer only, and accepts no event or role smuggling", () => {
  const parsed = eventTeamAddSchema.parse({ email: "  Ada@Example.COM ", role: "ADMIN" });
  assert.deepEqual(parsed, { email: "ada@example.com", role: "ADMIN" });

  // SPEAKER is provisioned by /admin/speakers, which also writes the profile.
  assert.equal(eventTeamAddSchema.safeParse({ email: "a@b.co", role: "SPEAKER" }).success, false);
  // No event id, ever: the signed ADMIN context is the only event authority.
  assert.equal(eventTeamAddSchema.safeParse({ email: "a@b.co", role: "ADMIN", eventId: "evt" }).success, false);
  assert.equal(eventTeamAddSchema.safeParse({ email: "not-an-email", role: "ADMIN" }).success, false);
});

test("the add contract takes NO name, because it never creates the account it resolves", () => {
  // Strict, so a client sending one is a validation failure rather than a
  // silently ignored field: nobody can believe they named or renamed a person
  // from this surface. The resolved account carries its own name.
  assert.equal(eventTeamAddSchema.safeParse({ email: "a@b.co", role: "ADMIN", name: "Ada" }).success, false);
  assert.ok(!("name" in eventTeamAddSchema.parse({ email: "a@b.co", role: "ADMIN" })));
});

test("an address with no account is a named refusal that spells out why, not a shell row", () => {
  // A shell User here could never be signed in to (no credential to sign a
  // reset token against) AND would make /api/auth/signup answer 409 forever,
  // taking away that person's only self-service way in. Nothing in this
  // codebase deletes a User, so the trap would be permanent. The refusal has to
  // carry all three facts, and the order that actually works.
  assert.equal(NO_ACCOUNT_FOR_EMAIL, "NO_ACCOUNT_FOR_EMAIL");
  assert.match(NO_ACCOUNT_FOR_EMAIL_MESSAGE, /No Greenroom account uses that email address/);
  assert.match(NO_ACCOUNT_FOR_EMAIL_MESSAGE, /a new account has no password/);
  assert.match(NO_ACCOUNT_FOR_EMAIL_MESSAGE, /only mails accounts that already have one/);
  assert.match(NO_ACCOUNT_FOR_EMAIL_MESSAGE, /block them from signing up themselves/);
  assert.match(NO_ACCOUNT_FOR_EMAIL_MESSAGE, /sign up at \/signup first, then add the same address here/);
});

test("the role-change contract addresses a user id and refuses to carry an identity", () => {
  for (const role of ["ADMIN", "EVALUATOR", "SPEAKER"]) {
    assert.equal(eventTeamRoleChangeSchema.safeParse({ userId: "u1", role }).success, true);
  }
  // Strict, so sending either is a validation failure rather than a silently
  // ignored field: a client can never believe it renamed somebody from here.
  assert.equal(eventTeamRoleChangeSchema.safeParse({ userId: "u1", role: "ADMIN", name: "New" }).success, false);
  assert.equal(eventTeamRoleChangeSchema.safeParse({ userId: "u1", role: "ADMIN", email: "x@y.z" }).success, false);
  assert.equal(eventTeamRoleChangeSchema.safeParse({ userId: "u1", role: "ORGANIZER" }).success, false);
  assert.equal(eventTeamRoleChangeSchema.safeParse({ userId: "", role: "ADMIN" }).success, false);
});

test("the team serializing key is per event, so one event's writes never block another's", () => {
  assert.equal(eventTeamLockKey("evt-1"), "event-team:evt-1");
  assert.notEqual(eventTeamLockKey("evt-1"), eventTeamLockKey("evt-2"));
});
