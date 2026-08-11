import assert from "node:assert/strict";
import { test } from "node:test";
import { portalProfileUpdateSchema, speakerProfileUpdateSchema } from "../../types/api";
import { PORTAL_PROFILE_FIELDS, profileFormValues, profilePatch, reconcileSavedProfile } from "./profile";

const stored = {
  bio: "Builds reliable systems.",
  company: "Acme Labs",
  jobTitle: "Staff Engineer",
  headshotUrl: "https://images.example.test/ada.jpg",
  slideDeckUrl: "https://slides.example.test/ada.pdf",
  eventSlideDeckUrl: "/api/files/clx1234567890",
};

test("profile patches preserve omitted fields and express cleared inputs as null", () => {
  const patch = profilePatch(
    profileFormValues(stored),
    profileFormValues({
      ...stored,
      company: "   ",
      headshotUrl: "",
      jobTitle: "  Principal Engineer  ",
    }),
  );
  assert.deepEqual(patch, {
    company: null,
    jobTitle: "Principal Engineer",
    headshotUrl: null,
  });
  assert.equal("bio" in patch, false);
  assert.equal("slideDeckUrl" in patch, false);
  assert.equal("eventSlideDeckUrl" in patch, false);
});

test("the per-event deck is a form field like any other, and clears independently", () => {
  // The form's field list is the FORM's, not SpeakerProfile's columns.
  assert.deepEqual(
    [...PORTAL_PROFILE_FIELDS],
    ["bio", "company", "jobTitle", "headshotUrl", "slideDeckUrl", "eventSlideDeckUrl"],
  );

  // Setting this event's deck touches nothing else — in particular not the
  // global column, which is a different event's fallback.
  assert.deepEqual(
    profilePatch(
      profileFormValues(stored),
      profileFormValues({ ...stored, eventSlideDeckUrl: "https://slides.example.test/forward-2026.pdf" }),
    ),
    { eventSlideDeckUrl: "https://slides.example.test/forward-2026.pdf" },
  );

  // Clearing this event's deck is an explicit null, and the global column is
  // still omitted — so the server deletes the association and preserves the
  // fallback rather than blanking both.
  const cleared = profilePatch(
    profileFormValues(stored),
    profileFormValues({ ...stored, eventSlideDeckUrl: "  " }),
  );
  assert.deepEqual(cleared, { eventSlideDeckUrl: null });
  assert.equal("slideDeckUrl" in cleared, false);

  // And the reverse: editing the global fallback leaves this event's deck alone.
  assert.deepEqual(
    profilePatch(
      profileFormValues(stored),
      profileFormValues({ ...stored, slideDeckUrl: "https://slides.example.test/new-global.pdf" }),
    ),
    { slideDeckUrl: "https://slides.example.test/new-global.pdf" },
  );
});

test("the portal body carries the association; the profile-column schema never does", () => {
  // The portal's own schema accepts it, with the same shapes as the global URL.
  assert.deepEqual(
    portalProfileUpdateSchema.parse({ eventSlideDeckUrl: "/api/files/clx1234567890" }),
    { eventSlideDeckUrl: "/api/files/clx1234567890" },
  );
  assert.deepEqual(
    portalProfileUpdateSchema.parse({ eventSlideDeckUrl: "  " }),
    { eventSlideDeckUrl: null },
  );
  assert.equal(portalProfileUpdateSchema.safeParse({ eventSlideDeckUrl: "../../etc/passwd" }).success, false);
  assert.equal(portalProfileUpdateSchema.safeParse({ eventSlideDeckUrl: "/api/files/x?y=1" }).success, false);

  // The SpeakerProfile-column schema — which the organizer roster editor picks
  // from and the v1 API's published object describes — is untouched by it.
  const parsed = speakerProfileUpdateSchema.parse({ eventSlideDeckUrl: "/api/files/clx1234567890" });
  assert.equal("eventSlideDeckUrl" in parsed, false);
});

test("profile API input normalizes blank explicit values to null without turning omissions into clears", () => {
  const parsed = speakerProfileUpdateSchema.parse({
    bio: "  ",
    company: "  Acme Labs  ",
    headshotUrl: " ",
    slideDeckUrl: null,
    socialLinks: {},
  });
  assert.deepEqual(parsed, {
    bio: null,
    company: "Acme Labs",
    headshotUrl: null,
    slideDeckUrl: null,
    socialLinks: null,
  });
  assert.deepEqual(speakerProfileUpdateSchema.parse({ jobTitle: "Staff Engineer" }), { jobTitle: "Staff Engineer" });
});

test("a successful profile save keeps edits typed after its request snapshot dirty", () => {
  const submitted = profileFormValues({ ...stored, jobTitle: "  Principal Engineer  " });
  const saved = profileFormValues({ ...stored, jobTitle: "Principal Engineer" });
  const current = { ...submitted, jobTitle: "Director of Engineering" };

  const reconciled = reconcileSavedProfile(submitted, current, saved);

  assert.equal(reconciled.jobTitle, "Director of Engineering");
  assert.equal(reconciled.company, saved.company);
  assert.deepEqual(profilePatch(saved, reconciled), { jobTitle: "Director of Engineering" });
});
