import assert from "node:assert/strict";
import { test } from "node:test";
import { speakerProfileUpdateSchema } from "@/types/api";
import { adminSpeakerProfilePatchSchema } from "@/lib/services/speaker-roster";

/**
 * The profile URL columns must hold an uploaded file's served path as well as
 * a pasted link — otherwise wiring the upload into either form produces a 422
 * on save, which is the failure mode a schema change like this exists to
 * prevent. Both surfaces are checked because the organizer's schema is derived
 * from the portal's (`.pick()`), and a derivation is not a guarantee.
 */

const parse = (patch: Record<string, unknown>) => speakerProfileUpdateSchema.safeParse(patch);

test("a stored-file path is accepted in both profile URL columns", () => {
  const result = parse({ headshotUrl: "/api/files/clx1234567890", slideDeckUrl: "/api/files/clx0987654321" });
  assert.equal(result.success, true, JSON.stringify(result.success ? {} : result.error.flatten().fieldErrors));
  assert.equal(result.success && result.data.headshotUrl, "/api/files/clx1234567890");
  assert.equal(result.success && result.data.slideDeckUrl, "/api/files/clx0987654321");
});

test("absolute links behave exactly as they did before the upload path was added", () => {
  const ok = parse({ headshotUrl: "https://cdn.example.test/a.png" });
  assert.equal(ok.success, true);
  assert.equal(ok.success && ok.data.headshotUrl, "https://cdn.example.test/a.png");

  // GRA2-07 is a documented follow-up, deliberately NOT fixed here: the
  // `.url()` branch is untouched, so a non-HTTP scheme is still accepted by
  // the schema and still re-filtered by the public image renderer. Pinning it
  // means a later tightening is a deliberate act, not an accident of this lane.
  assert.equal(parse({ headshotUrl: "ftp://files.example.test/a.png" }).success, true);

  // Blank still clears, whitespace still trims, omitted is still omitted.
  const cleared = parse({ headshotUrl: "   " });
  assert.equal(cleared.success && cleared.data.headshotUrl, null);
  assert.equal(parse({}).success && !("headshotUrl" in (parse({}) as { data: object }).data), true);
});

test("a relative path that is not an upload URL is still refused", () => {
  for (const rejected of [
    "/admin/settings",
    "/api/files/",
    "/api/files/x/../../admin",
    "//evil.test/api/files/x",
    "not a url",
    "/uploads/a.png",
  ]) {
    const result = parse({ headshotUrl: rejected });
    assert.equal(result.success, false, `${rejected} must not be storable as a profile URL`);
    assert.deepEqual(
      Object.keys(result.success ? {} : result.error.flatten().fieldErrors),
      ["headshotUrl"],
      "the refusal must be attributed to the field, not the root",
    );
  }
});

test("the organizer's roster schema inherits the same acceptance, not a second copy", () => {
  const ok = adminSpeakerProfilePatchSchema.safeParse({
    userId: "user-1",
    headshotUrl: "/api/files/clx1234567890",
  });
  assert.equal(ok.success, true, JSON.stringify(ok.success ? {} : ok.error.flatten().fieldErrors));
  assert.equal(
    adminSpeakerProfilePatchSchema.safeParse({ userId: "user-1", headshotUrl: "/admin/settings" }).success,
    false,
  );
});
