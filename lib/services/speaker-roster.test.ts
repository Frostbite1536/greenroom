import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ADMIN_SPEAKER_PROFILE_FIELDS,
  adminSpeakerCreateSchema,
  adminSpeakerProfileFields,
  adminSpeakerProfilePatchSchema,
  speakerProfileLockKey,
  speakerProfileWriteData,
} from "./speaker-roster";
import { speakerProfileUpdateSchema } from "@/types/api";

test("the organizer's profile rules are the portal's own rules, minus socialLinks", () => {
  // Not a copy: the shape is picked from the portal schema, so a field rule can
  // only ever be changed in one place (C13).
  assert.deepEqual(
    Object.keys(adminSpeakerProfileFields.shape).sort(),
    [...ADMIN_SPEAKER_PROFILE_FIELDS].sort(),
  );
  assert.ok(Object.keys(speakerProfileUpdateSchema.shape).includes("socialLinks"));
  assert.ok(!Object.keys(adminSpeakerProfileFields.shape).includes("socialLinks"));
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
