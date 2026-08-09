import assert from "node:assert/strict";
import { test } from "node:test";
import { speakerProfileUpdateSchema } from "../../types/api";
import { profileFormValues, profilePatch, reconcileSavedProfile } from "./profile";

const stored = {
  bio: "Builds reliable systems.",
  company: "Acme Labs",
  jobTitle: "Staff Engineer",
  headshotUrl: "https://images.example.test/ada.jpg",
  slideDeckUrl: "https://slides.example.test/ada.pdf",
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
