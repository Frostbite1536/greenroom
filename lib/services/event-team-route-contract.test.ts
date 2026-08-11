import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Source-level contract for the event team routes, in the same style as the S1
 * and SPK-02 route-contract suites: these are ordering, status and absence
 * properties that no unit test over a pure function can observe, and that a
 * refactor could silently drop.
 *
 * Every pattern here is whitespace-tolerant (`\s`, never a literal newline), so
 * a CRLF checkout reads identically to an LF one.
 */
const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const route = source("app/api/admin/team/route.ts");
const post = route.slice(route.indexOf("export const POST"), route.indexOf("export const PATCH"));
const patch = route.slice(route.indexOf("export const PATCH"), route.indexOf("export const DELETE"));
const del = route.slice(route.indexOf("export const DELETE"));
const page = source("app/(app)/admin/team/page.tsx");
const shell = source("components/app-shell.tsx");

test("all three handlers are ADMIN-only and take their event from the session", () => {
  for (const handler of [post, patch, del]) {
    assert.match(handler, /requireContext\(\["ADMIN"\]\)/);
    assert.match(handler, /ctx\.eventId/);
  }
  // No handler accepts an event id from the caller, and the schemas are strict.
  assert.doesNotMatch(route, /eventId:\s*idSchema/);
  assert.doesNotMatch(route, /searchParams\.get\("eventId"\)/);
});

test("the caller's stored ADMIN authority is re-read under each write's own lock (S1)", () => {
  for (const handler of [post, patch, del]) {
    assert.match(handler, /const issuer = members\.find\(\(member\) => member\.userId === ctx\.userId\)/);
    assert.match(handler, /if \(issuer\?\.role !== "ADMIN"\) throw forbidden\(\)/);
    // The authority check happens after the locked read, never before it.
    assert.ok(handler.indexOf("lockEventMemberAuthorities") < handler.indexOf('issuer?.role !== "ADMIN"'));
    // …and the write is inside that same transaction.
    assert.match(handler, /prisma\.\$transaction\(/);
  }
});

test("the event team key is taken FIRST, before every C17 key, in all three handlers", () => {
  // The last-ADMIN rule is a predicate over the whole event. Per-member
  // authority keys cannot hold it: two concurrent demotions of two different
  // admins would each lock only their own target and each read two.
  for (const handler of [post, patch, del]) {
    assert.match(handler, /await lockEventTeam\(tx, ctx\.eventId\)/);
    assert.ok(handler.indexOf("lockEventTeam") < handler.indexOf("lockEventMemberAuthorities"));
    assert.ok(handler.indexOf("lockEventMemberAuthorities") < handler.indexOf("lockExistingEventMembersForUpdate"));
  }
  // The identity key sits between them on the only handler that resolves an email.
  assert.ok(post.indexOf("lockEventTeam") < post.indexOf("lockPublicSubmissionIdentities"));
  assert.ok(post.indexOf("lockPublicSubmissionIdentities") < post.indexOf("lockEventMemberAuthorities"));
  // PATCH and DELETE address a user id and must never take the identity key.
  assert.doesNotMatch(patch, /lockPublicSubmissionIdentities/);
  assert.doesNotMatch(del, /lockPublicSubmissionIdentities/);
});

test("C17: adding by email reuses the account and never overwrites its global name", () => {
  assert.match(post, /lockPublicSubmissionIdentities\(tx, \[email\]\)/);
  assert.ok(post.indexOf("lockPublicSubmissionIdentities") < post.indexOf("tx.user.upsert"));
  assert.match(post, /tx\.user\.upsert\(\{[\s\S]*?where:\s*\{ email \},[\s\S]*?update:\s*\{\},[\s\S]*?create:\s*\{ email, name \}/);
  // `userCreated` distinguishes the existing-account case from the new-shell
  // case, which is the whole difference the UI has to report honestly.
  assert.match(post, /const existing = await tx\.user\.findUnique\(\{ where: \{ email \}/);
  assert.match(post, /userCreated:\s*existing === null/);
  // The membership is created only when absent, which is what makes a repeat
  // POST a no-op rather than a duplicate or a silent re-role.
  assert.match(post, /if \(!target\) \{\s*await tx\.eventMember\.create\(\{ data: \{ eventId: ctx\.eventId, userId: user\.id, role \} \}\);/);
  assert.ok(post.indexOf("lockExistingEventMembersForUpdate") < post.indexOf("tx.eventMember.create"));
});

test("no handler here writes a User email or renames a user", () => {
  // `create: { email, name }` on a brand-new account is the only place either
  // appears; no update path may carry them.
  assert.doesNotMatch(route, /tx\.user\.update/);
  assert.doesNotMatch(route, /update:\s*\{[^}]*email/);
  assert.doesNotMatch(route, /update:\s*\{[^}]*name/);
});

test("an add can never become a demotion — a different existing role is refused", () => {
  assert.match(post, /if \(target && target\.role !== role\)/);
  assert.match(post, /"TEAM_ROLE_CONFLICT"/);
  // Only PATCH updates a role, and only DELETE removes one, so the guards
  // cannot be routed around by the add form.
  assert.doesNotMatch(post, /tx\.eventMember\.update/);
  assert.doesNotMatch(post, /tx\.eventMember\.delete/);
});

test("unknown and cross-event user ids are one indistinguishable 404", () => {
  assert.match(route, /new ApiError\(404, "TEAM_MEMBER_NOT_FOUND", "Team member not found\."\)/);
  // The membership rows are read scoped to ctx.eventId, so a member of another
  // event simply is not in `members` and takes the same branch as a missing id.
  for (const handler of [patch, del]) {
    assert.match(handler, /lockExistingEventMembersForUpdate\(tx, ctx\.eventId, \[ctx\.userId, userId\]\)/);
    assert.match(handler, /const target = members\.find\(\(member\) => member\.userId === userId\)/);
    assert.match(handler, /if \(!target\) throw memberNotFound\(\)/);
  }
  // One refusal shape exists, so the two cases cannot drift apart.
  assert.equal((route.match(/TEAM_MEMBER_NOT_FOUND/g) ?? []).length, 1);
});

test("every guard is a named 422 decided from counts read inside the writing transaction", () => {
  assert.match(patch, /const decision = decideRoleChange\(\{/);
  assert.match(del, /const decision = decideMemberRemoval\(\{/);
  for (const handler of [patch, del]) {
    assert.match(handler, /const facts = await readGuardFacts\(tx, ctx\.eventId, userId\)/);
    // 422, per the convention — never a bare 400.
    assert.match(handler, /if \(!decision\.allowed\) throw new ApiError\(422, decision\.code, decision\.message\)/);
    // Facts are read AFTER the member rows are locked, and the write happens
    // AFTER the decision: no TOCTOU window on either side.
    assert.ok(handler.indexOf("lockExistingEventMembersForUpdate") < handler.indexOf("readGuardFacts"));
    assert.ok(handler.indexOf("readGuardFacts") < handler.indexOf("decision.allowed"));
  }
  assert.ok(patch.indexOf("decision.allowed") < patch.indexOf("tx.eventMember.update"));
  assert.ok(del.indexOf("decision.allowed") < del.indexOf("tx.eventMember.delete"));
  assert.doesNotMatch(route, /new ApiError\(400, "(LAST_ADMIN|EVALUATOR_HAS_ASSIGNMENTS|SPEAKER_HAS_PROGRAMME_WORK)"/);
});

test("the guard facts are the four counts the decisions consume, all event-scoped", () => {
  const facts = route.slice(route.indexOf("async function readGuardFacts"), route.indexOf("export const POST"));
  assert.match(facts, /countEventAdmins\(tx, eventId\)/);
  assert.match(facts, /countActiveAssignments\(tx, eventId, userId\)/);
  // Sessions and tasks are reached through THIS event only: another event's
  // programme must not block a change here.
  assert.match(facts, /tx\.sessionSpeaker\.count\(\{ where: \{ userId, session: \{ eventId \} \} \}\)/);
  assert.match(facts, /tx\.speakerTask\.count\(\{ where: \{ userId, task: \{ eventId \} \} \}\)/);
});

test("the caller demoting or removing themself takes the same guarded path as anyone else", () => {
  // No `userId === ctx.userId` early exit anywhere: self is a flag passed into
  // the decision so the refusal can be worded for them, never a bypass.
  for (const handler of [patch, del]) {
    assert.match(handler, /self:\s*userId === ctx\.userId/);
  }
  assert.doesNotMatch(route, /if \(userId === ctx\.userId\) (return|throw)/);
});

test("only the EventMember row is written — no User, profile, session or task is destroyed", () => {
  assert.match(patch, /tx\.eventMember\.update\(\{\s*where: \{ eventId_userId: \{ eventId: ctx\.eventId, userId \} \}/);
  assert.match(del, /tx\.eventMember\.delete\(\{ where: \{ eventId_userId: \{ eventId: ctx\.eventId, userId \} \} \}\)/);
  for (const table of ["user", "speakerProfile", "session", "sessionSpeaker", "speakerTask", "reviewAssignment"]) {
    assert.doesNotMatch(route, new RegExp(`tx\\.${table}\\.(delete|deleteMany|update|updateMany)\\(`));
  }
});

test("no notification mail is bolted on for an access path that does not exist", () => {
  // A newly provisioned account cannot sign in at all, so a "you were added"
  // email would point somebody at a door that does not open for them.
  assert.doesNotMatch(route, /dispatchEmail|renderEmailTemplate|emailTemplate/);
});

test("the members page is server-rendered, ADMIN-only, and marks the caller", () => {
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.doesNotMatch(page, /"use client"/);
  // Redirect rather than throw, matching the other admin pages.
  assert.match(page, /const ctx = await getApiContext\(\)/);
  assert.match(page, /if \(!ctx\) redirect\("\/login"\)/);
  assert.match(page, /if \(ctx\.role !== "ADMIN"\) redirect\("\/portal"\)/);
  // Every member, with the caller marked.
  assert.match(page, /readEventTeam\(ctx\.eventId\)/);
  assert.match(page, /const isSelf = member\.userId === ctx\.userId/);
  assert.match(page, /\(you\)/);
  assert.match(page, /member\.email/);
  assert.match(page, /TEAM_ROLE_LABELS\[member\.role\]/);
  assert.match(page, /formatEventDateTime\(member\.joinedAt, timezone\)/);
});

test("the nav entry exists, is ADMIN-only, and points at the page that enforces it", () => {
  assert.match(shell, /\{ href: "\/admin\/team", label: "Event team", icon: \w+, roles: \["ADMIN"\] \}/);
});
