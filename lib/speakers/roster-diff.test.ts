import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SPEAKER_PROFILE_TEXT_FIELDS,
  speakerProfileDiff,
  speakerProfileDiffIsEmpty,
  speakerProfileValue,
  type SpeakerProfileDraftValues,
} from "./roster";
import { speakerProfileWriteData } from "@/lib/services/speaker-roster";

/**
 * GRA-05 — the admin roster editor must not clobber a newer speaker edit.
 *
 * The dialog opens on a server-rendered snapshot of a GLOBAL `SpeakerProfile`
 * row that the speaker can be editing from their portal at the same moment.
 * Sending the whole snapshot back writes their save away with nothing shown to
 * either party. The fix is a dirty-field diff, and this file pins both halves
 * of the round trip: the diff sends only what changed, and the server's write
 * data preserves whatever the diff omitted.
 *
 * Source assertions are CRLF-safe: no pattern crosses a line break.
 */
const FULL: SpeakerProfileDraftValues = {
  jobTitle: "Staff Engineer",
  company: "Lumen Grid",
  bio: "Priya has run platform reliability for eight years.",
  headshotUrl: "https://images.example.test/priya.jpg",
  status: "CONFIRMED",
};

const draft = (over: Partial<SpeakerProfileDraftValues> = {}): SpeakerProfileDraftValues =>
  ({ ...FULL, ...over });

test("an untouched dialog produces no patch at all", () => {
  const patch = speakerProfileDiff(FULL, draft());
  assert.deepEqual(patch, {});
  assert.equal(speakerProfileDiffIsEmpty(patch), true);
});

test("changing one field sends that field and nothing else", () => {
  const patch = speakerProfileDiff(FULL, draft({ company: "Northwind" }));
  assert.deepEqual(patch, { company: "Northwind" });
  assert.equal(speakerProfileDiffIsEmpty(patch), false);
  // The point of the whole fix: the bio the speaker just saved is not in the body.
  assert.ok(!("bio" in patch));
  assert.ok(!("status" in patch));
});

test("emptying a field is a real clear, not an omission", () => {
  const patch = speakerProfileDiff(FULL, draft({ bio: "" }));
  assert.deepEqual(patch, { bio: null });
  // `null` and "absent" must never be confused — one clears, one preserves.
  assert.ok("bio" in patch);
  assert.equal(patch.bio, null);
});

test("re-spacing a value is not an edit, so a no-op save writes nothing", () => {
  const patch = speakerProfileDiff(FULL, draft({ company: "  Lumen Grid  " }));
  assert.deepEqual(patch, {});
});

test("whitespace-only text clears, exactly like an empty string", () => {
  assert.deepEqual(speakerProfileDiff(FULL, draft({ jobTitle: "   " })), { jobTitle: null });
});

test("a field that was already empty and stays empty is never sent", () => {
  const blank = draft({ bio: "" });
  assert.deepEqual(speakerProfileDiff(blank, draft({ bio: "   " })), {});
});

test("status is diffed too, and is never sent as null", () => {
  assert.deepEqual(speakerProfileDiff(FULL, draft({ status: "INVITED" })), { status: "INVITED" });
  for (const change of [{ bio: "" }, { company: "x" }, { jobTitle: "" }]) {
    assert.ok(!("status" in speakerProfileDiff(FULL, draft(change))));
  }
});

test("every rendered text field can be diffed independently", () => {
  for (const field of SPEAKER_PROFILE_TEXT_FIELDS) {
    const patch = speakerProfileDiff(FULL, draft({ [field]: "changed" }));
    assert.deepEqual(Object.keys(patch), [field], `${field} leaked other fields`);
  }
});

test("normalization matches what the payload builder sends", () => {
  assert.equal(speakerProfileValue("  hi  "), "hi");
  assert.equal(speakerProfileValue("   "), null);
  assert.equal(speakerProfileValue(""), null);
});

/**
 * The server half, pinned against the same patch the client now produces: an
 * omitted field must reach Prisma omitted, so the stored value survives.
 */
test("a one-field patch reaches Prisma as a one-field update", () => {
  const patch = speakerProfileDiff(FULL, draft({ company: "Northwind" }));
  const data = speakerProfileWriteData(patch);
  assert.deepEqual(data, { company: "Northwind" });
  // Anything Prisma is not told about is left alone — that is the preservation.
  for (const field of ["bio", "jobTitle", "headshotUrl", "status"]) {
    assert.ok(!(field in data), `${field} must not be written by a company-only edit`);
  }
});

test("a cleared field reaches Prisma as an explicit null", () => {
  const data = speakerProfileWriteData(speakerProfileDiff(FULL, draft({ bio: "" })));
  assert.deepEqual(data, { bio: null });
});

test("an empty patch asks Prisma to write nothing", () => {
  assert.deepEqual(speakerProfileWriteData(speakerProfileDiff(FULL, draft())), {});
});

/**
 * Source pin: the roster manager must DIFF before sending. A future edit that
 * reinstates the whole-snapshot payload on the edit path reintroduces GRA-05,
 * and no pure test would catch it because the helper would still be correct.
 */
const manager = readFileSync(
  new URL("../../components/speaker-roster-manager.tsx", import.meta.url),
  "utf8",
);

test("the edit dialog sends a diff, never its whole loaded snapshot", () => {
  assert.match(manager, /const patch = speakerProfileDiff\(baseline, draft\)/);
  assert.match(manager, /\.\.\.patch,/);
  // The full-payload builder survives for the ADD path only, where there is no
  // prior value to clobber. Exactly one call site may remain.
  assert.equal((manager.match(/\.\.\.profilePayload\(draft\)/g) ?? []).length, 1);
  assert.match(manager, /apiPost<SpeakerResponse>\("\/api\/admin\/speakers", \{/);
});

test("the edit dialog keeps a baseline and re-seeds it when reopened", () => {
  assert.match(manager, /const \[baseline, setBaseline\] = useState<SpeakerProfileDraft>/);
  assert.match(manager, /setBaseline\(draftFromSpeaker\(speaker\)\)/);
});

test("an unchanged edit makes no request instead of provoking a 422", () => {
  // The PATCH schema refuses an all-omitted body; a no-op save must not ask.
  assert.match(manager, /if \(speakerProfileDiffIsEmpty\(patch\)\) \{/);
  assert.ok(
    manager.indexOf("speakerProfileDiffIsEmpty(patch)") < manager.indexOf("apiPatch<unknown>"),
    "the empty-diff guard must run before the request",
  );
});
