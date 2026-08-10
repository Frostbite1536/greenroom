import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Source-level contract for the organizer speaker routes (SPK-02), in the same
 * style as the S1 route-contract suite: these are ordering and absence
 * properties that no unit test over a pure function can observe, and that a
 * refactor could silently drop.
 */
const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const route = source("app/api/admin/speakers/route.ts");
const post = route.slice(route.indexOf("export const POST"), route.indexOf("export const PATCH"));
const patch = route.slice(route.indexOf("export const PATCH"));

test("both speaker-admin handlers are ADMIN-only and take their event from the session", () => {
  assert.match(post, /requireContext\(\["ADMIN"\]\)/);
  assert.match(patch, /requireContext\(\["ADMIN"\]\)/);
  // No handler accepts an event id, and both schemas are strict about it.
  assert.doesNotMatch(route, /eventId:\s*idSchema/);
  assert.match(route, /ctx\.eventId/);
});

test("C17 lock order: identity, then membership authority, then the membership rows", () => {
  assert.match(post, /prisma\.\$transaction\(/);
  assert.match(post, /lockPublicSubmissionIdentities\(tx, \[email\]\)/);
  assert.match(post, /lockEventMemberAuthorities\(tx, \[/);
  assert.match(post, /lockExistingEventMembersForUpdate\(tx, ctx\.eventId, \[ctx\.userId, user\.id\]\)/);
  assert.ok(post.indexOf("lockPublicSubmissionIdentities") < post.indexOf("tx.user.upsert"));
  assert.ok(post.indexOf("lockEventMemberAuthorities") < post.indexOf("lockExistingEventMembersForUpdate"));
  assert.ok(post.indexOf("lockExistingEventMembersForUpdate") < post.indexOf("tx.eventMember.create"));
});

test("the caller's stored ADMIN authority is re-read under the write's own lock (S1)", () => {
  for (const handler of [post, patch]) {
    assert.match(handler, /const issuer = members\.find\(\(member\) => member\.userId === ctx\.userId\)/);
    assert.match(handler, /if \(issuer\?\.role !== "ADMIN"\) throw forbidden\(\)/);
    // The authority check happens after the locked read, not before it.
    assert.ok(handler.indexOf("lockEventMemberAuthorities") < handler.indexOf("issuer?.role !== \"ADMIN\""));
  }
});

test("adding a speaker never overwrites the account's global name (C17)", () => {
  assert.match(post, /tx\.user\.upsert\(\{[\s\S]*?where: \{ email \},[\s\S]*?update: \{\},[\s\S]*?create: \{ email, name \}/);
  // Membership is created only when it is absent, which is what makes a repeat
  // POST a no-op rather than a duplicate.
  assert.match(post, /if \(!target\) \{\s*await tx\.eventMember\.create\(\{ data: \{ eventId: ctx\.eventId, userId: user\.id, role: "SPEAKER" \} \}\);/);
});

test("neither handler ever writes a User email or renames a user", () => {
  // `create: { email, name }` on a brand-new account is the only place either
  // appears; no update path may carry them.
  assert.doesNotMatch(route, /tx\.user\.update/);
  assert.doesNotMatch(route, /update: \{[^}]*email/);
  assert.doesNotMatch(route, /update: \{[^}]*name/);
});

test("a role that is not SPEAKER is refused, never silently changed", () => {
  assert.match(post, /if \(target && target\.role !== "SPEAKER"\)/);
  assert.match(post, /"SPEAKER_ROLE_CONFLICT"/);
  assert.doesNotMatch(route, /tx\.eventMember\.update/);
  assert.doesNotMatch(route, /role: "ADMIN"\s*\}/);
});

test("the profile write is serialized and only touches supplied fields", () => {
  for (const handler of [post, patch]) {
    assert.match(handler, /lockSpeakerProfile\(tx, /);
    assert.match(handler, /tx\.speakerProfile\.upsert\(/);
    assert.ok(handler.indexOf("lockSpeakerProfile") < handler.indexOf("tx.speakerProfile.upsert"));
    assert.match(handler, /update: profileData/);
  }
  // An add with no profile fields must not create an empty profile row.
  assert.match(post, /const profileRequested = Object\.keys\(profileData\)\.length > 0;/);
  assert.match(post, /if \(profileRequested\) \{/);
});

test("an unknown, cross-event, or non-speaker user id is one indistinguishable 404", () => {
  assert.match(route, /new ApiError\(404, "SPEAKER_NOT_FOUND", "Speaker not found\."\)/);
  // The roster membership test is the same union the page renders: a named
  // speaker, or someone on one of this event's sessions.
  assert.match(patch, /target\?\.role === "SPEAKER"/);
  assert.match(patch, /tx\.sessionSpeaker\.count\(\{[\s\S]*?session: \{ eventId: ctx\.eventId \}/);
  assert.match(patch, /if \(!onRoster\) throw speakerNotFound\(\)/);
  // Only one refusal shape exists, so the two cases cannot drift apart.
  assert.equal((route.match(/SPEAKER_NOT_FOUND/g) ?? []).length, 1);
});

test("an organizer may write a global profile only for a speaker who is theirs alone", () => {
  // The write is gated on a fresh in-transaction read, not a pre-flight check.
  for (const handler of [post, patch]) {
    assert.match(handler, /countOtherEventMemberships\(tx, /);
    // Taken after the profile key, so two organizers adding the same person to
    // different events cannot both read "exclusive" and both write.
    assert.ok(handler.indexOf("lockSpeakerProfile") < handler.indexOf("countOtherEventMemberships"));
    assert.ok(handler.indexOf("countOtherEventMemberships") < handler.indexOf("tx.speakerProfile.upsert"));
  }
});

test("the shared-profile refusal never precedes the roster check that hides existence", () => {
  // A 409 for somebody not on this event's roster would confirm they exist
  // somewhere — exactly what the single 404 is there to refuse to reveal.
  assert.ok(patch.indexOf("if (!onRoster) throw speakerNotFound()") < patch.indexOf("countOtherEventMemberships"));
  assert.match(patch, /throw new ApiError\(409, SPEAKER_SHARED_ACROSS_EVENTS, SPEAKER_SHARED_MESSAGE\)/);
});

test("adding a shared speaker still joins them to this event, withholding only the profile", () => {
  // The membership is this event's own row and stays within its authority; only
  // the global half is skipped, and the response reports which half landed.
  assert.ok(post.indexOf("tx.eventMember.create") < post.indexOf("countOtherEventMemberships"));
  assert.match(post, /if \(!sharedAcrossEvents\) \{/);
  assert.match(post, /profileRequested,\s*\n\s*profileApplied,\s*\n\s*sharedAcrossEvents,/);
  // The add is never refused for being shared — that would block a speaker who
  // legitimately appears at two events.
  assert.doesNotMatch(post, /SPEAKER_SHARED_ACROSS_EVENTS/);
});

test("SPK-04: a speaker's status is written through the same guarded profile payload", () => {
  // `status` lives on the global SpeakerProfile row, so it must inherit the
  // shared-speaker refusal rather than sneak past it on a separate write. The
  // guarantee is structural: `speakerProfileWriteData` produces the one payload
  // both handlers pass to the one upsert, and that upsert sits behind the 409.
  assert.deepEqual(route.match(/tx\.speakerProfile\.upsert\(/g)?.length, 2);
  assert.deepEqual(route.match(/update: profileData,/g)?.length, 2);
  assert.deepEqual(route.match(/speakerProfileWriteData\(profile\)/g)?.length, 2);
  // Nothing writes a SpeakerProfile outside that guarded payload.
  assert.doesNotMatch(route, /speakerProfile\.(update|create)\(/);
  assert.doesNotMatch(route, /status:\s*(input|patch|body)/);
  // A status-bearing edit therefore takes the profile key, counts other
  // memberships, and only then reaches the row.
  assert.ok(patch.indexOf("lockSpeakerProfile") < patch.indexOf("countOtherEventMemberships"));
  assert.ok(patch.indexOf("countOtherEventMemberships") < patch.indexOf("tx.speakerProfile.upsert"));
  // And it is projected back, so the roster re-renders from stored truth.
  assert.match(route, /status: true,/);
});
