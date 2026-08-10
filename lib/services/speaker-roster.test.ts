import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ADMIN_SPEAKER_PROFILE_FIELDS,
  SPEAKER_SHARED_ACROSS_EVENTS,
  SPEAKER_SHARED_MESSAGE,
  SPEAKER_STATUSES,
  adminSpeakerCreateSchema,
  adminSpeakerProfileFields,
  adminSpeakerProfilePatchSchema,
  countOtherEventMemberships,
  speakerProfileLockKey,
  speakerProfileWriteData,
} from "./speaker-roster";
import { speakerProfileUpdateSchema } from "@/types/api";

test("the organizer's profile rules are the portal's own rules, minus socialLinks", () => {
  // Not a copy: every prose field is picked from the portal schema, so a field
  // rule can only ever be changed in one place (C13). `status` is the single
  // deliberate addition — it is the organizer's record about a speaker, not
  // prose the speaker writes about themselves, so it is not in the portal
  // schema at all and must not silently appear there.
  assert.deepEqual(
    Object.keys(adminSpeakerProfileFields.shape).sort(),
    [...ADMIN_SPEAKER_PROFILE_FIELDS, "status"].sort(),
  );
  assert.ok(Object.keys(speakerProfileUpdateSchema.shape).includes("socialLinks"));
  assert.ok(!Object.keys(adminSpeakerProfileFields.shape).includes("socialLinks"));
  assert.ok(!Object.keys(speakerProfileUpdateSchema.shape).includes("status"));
});

test("SPK-04: status is a bounded three-state record, and omitting it changes nothing", () => {
  assert.deepEqual([...SPEAKER_STATUSES], ["INVITED", "CONFIRMED", "DECLINED"]);
  assert.equal(adminSpeakerProfileFields.parse({ status: "DECLINED" }).status, "DECLINED");
  assert.equal(adminSpeakerProfileFields.safeParse({ status: "MAYBE" }).success, false);
  // There is no clearing a status: the column has a stored default.
  assert.equal(adminSpeakerProfileFields.safeParse({ status: null }).success, false);
  assert.ok(!("status" in adminSpeakerProfileFields.parse({ bio: "x" })));
});

test("a status-only edit is a real edit, and reaches the write as one field", () => {
  const patch = adminSpeakerProfilePatchSchema.safeParse({ userId: "user-1", status: "CONFIRMED" });
  assert.equal(patch.success, true);
  assert.deepEqual(speakerProfileWriteData({ status: "CONFIRMED" }), { status: "CONFIRMED" });
  // An omitted status leaves the stored one alone, exactly like an omitted bio.
  assert.deepEqual(speakerProfileWriteData({ bio: "Builds things" }), { bio: "Builds things" });
  // A patch that says nothing at all is still refused.
  assert.equal(adminSpeakerProfilePatchSchema.safeParse({ userId: "user-1" }).success, false);
});

test("C13 normalization: trim to a value, blank to an explicit null, omitted stays omitted", () => {
  const parsed = adminSpeakerProfileFields.parse({ bio: "  Builds things  ", company: "", jobTitle: "   " });
  assert.equal(parsed.bio, "Builds things");
  assert.equal(parsed.company, null);
  assert.equal(parsed.jobTitle, null);
  assert.ok(!("headshotUrl" in parsed));
  // An explicit null is a real clear instruction and survives parsing.
  assert.equal(adminSpeakerProfileFields.parse({ bio: null }).bio, null);
});

test("a headshot must be a URL, and clearing one is not a broken URL", () => {
  assert.equal(adminSpeakerProfileFields.parse({ headshotUrl: "https://images.test/a.jpg" }).headshotUrl, "https://images.test/a.jpg");
  assert.equal(adminSpeakerProfileFields.parse({ headshotUrl: "  " }).headshotUrl, null);
  assert.equal(adminSpeakerProfileFields.safeParse({ headshotUrl: "images.test/a.jpg" }).success, false);
});

test("adding a speaker normalizes the email identity the same way reviewer provisioning does", () => {
  const parsed = adminSpeakerCreateSchema.parse({ email: "  Nadia@Northwind.TEST ", name: "  Nadia Okonkwo " });
  assert.equal(parsed.email, "nadia@northwind.test");
  assert.equal(parsed.name, "Nadia Okonkwo");
  assert.equal(adminSpeakerCreateSchema.safeParse({ email: "not-an-email", name: "X" }).success, false);
  assert.equal(adminSpeakerCreateSchema.safeParse({ email: "a@b.test", name: "   " }).success, false);
});

test("no authority id can be smuggled into an add", () => {
  for (const extra of [{ eventId: "other-event" }, { role: "ADMIN" }, { userId: "user-9" }]) {
    const result = adminSpeakerCreateSchema.safeParse({ email: "a@b.test", name: "A", ...extra });
    assert.equal(result.success, false, `expected ${JSON.stringify(extra)} to be rejected`);
  }
});

test("an admin profile edit cannot rename or re-address the account", () => {
  // Rejected loudly rather than ignored quietly: a client must never be able to
  // believe it changed a global identity (S10 / C26 live elsewhere).
  assert.equal(adminSpeakerProfilePatchSchema.safeParse({ userId: "user-1", name: "New Name" }).success, false);
  assert.equal(adminSpeakerProfilePatchSchema.safeParse({ userId: "user-1", email: "new@b.test" }).success, false);
});

test("an edit must actually carry a field, and an explicit null counts as one", () => {
  assert.equal(adminSpeakerProfilePatchSchema.safeParse({ userId: "user-1" }).success, false);
  const cleared = adminSpeakerProfilePatchSchema.parse({ userId: "user-1", bio: null });
  assert.equal(cleared.bio, null);
  assert.equal(adminSpeakerProfilePatchSchema.safeParse({ userId: "user-1", bio: "" }).success, true);
});

test("only supplied fields reach the database, and null reaches it as null", () => {
  assert.deepEqual(speakerProfileWriteData({ bio: "Hello", company: null }), { bio: "Hello", company: null });
  assert.deepEqual(speakerProfileWriteData({ bio: undefined }), {});
  assert.deepEqual(speakerProfileWriteData({}), {});
  // An all-omitted patch is empty, which is what lets a caller skip the write.
  assert.equal(Object.keys(speakerProfileWriteData({ jobTitle: undefined, headshotUrl: undefined })).length, 0);
});

test("the profile lock key is stable and per-user", () => {
  assert.equal(speakerProfileLockKey("user-1"), "speaker-profile:user-1");
  assert.notEqual(speakerProfileLockKey("user-1"), speakerProfileLockKey("user-2"));
});

// ---- a global profile is not an event's to write ---------------------------

function countingTx(result: number) {
  const calls: unknown[] = [];
  const tx = {
    eventMember: {
      count: async (args: unknown) => {
        calls.push(args);
        return result;
      },
    },
  };
  return { tx: tx as never, calls };
}

test("the shared-profile question asks about OTHER events, never this one", async () => {
  const { tx, calls } = countingTx(0);
  const count = await countOtherEventMemberships(tx, "user-1", "event-a");
  assert.equal(count, 0);
  assert.deepEqual(calls, [{ where: { userId: "user-1", eventId: { not: "event-a" } } }]);
});

test("a speaker who belongs to another event is reported as shared", async () => {
  const { tx } = countingTx(2);
  assert.equal(await countOtherEventMemberships(tx, "user-1", "event-a"), 2);
});

test("the shared refusal is a stable code carrying a way forward, not a dead end", () => {
  assert.equal(SPEAKER_SHARED_ACROSS_EVENTS, "SPEAKER_SHARED_ACROSS_EVENTS");
  // Non-technical organizers read this, so it has to say why and what to do.
  assert.match(SPEAKER_SHARED_MESSAGE, /also takes part in another event/);
  assert.match(SPEAKER_SHARED_MESSAGE, /shared across every event/);
  assert.match(SPEAKER_SHARED_MESSAGE, /speaker portal/);
  assert.doesNotMatch(SPEAKER_SHARED_MESSAGE, /EventMember|SpeakerProfile|409/);
});
