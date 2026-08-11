import assert from "node:assert/strict";
import { test } from "node:test";
import {
  legacyStoredFileDedupeKey,
  storedFileDedupeKey,
} from "./stored-file-dedupe";

const base = {
  uploaderUserId: "speaker",
  eventId: "event-a",
  contentSha256: "ABCDEF",
} as const;

test("public headshot dedupe stays on the normalized raw content digest", () => {
  const eventA = storedFileDedupeKey({ ...base, kind: "HEADSHOT" });
  const eventB = storedFileDedupeKey({ ...base, eventId: "event-b", kind: "HEADSHOT" });
  assert.deepEqual(eventA, { uploaderUserId: "speaker", kind: "HEADSHOT", sha256: "abcdef" });
  assert.deepEqual(eventB, eventA);
});

test("private slide-deck dedupe is stable within one event and distinct across events", () => {
  const eventA = storedFileDedupeKey({ ...base, kind: "SLIDE_DECK" });
  const eventAAgain = storedFileDedupeKey({ ...base, kind: "SLIDE_DECK" });
  const eventB = storedFileDedupeKey({ ...base, eventId: "event-b", kind: "SLIDE_DECK" });

  assert.deepEqual(eventAAgain, eventA);
  assert.match(eventA.sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(eventA.sha256, base.contentSha256.toLowerCase());
  assert.notEqual(eventB.sha256, eventA.sha256);
});

test("legacy lookup names the old raw digest without weakening the scoped key", () => {
  const scoped = storedFileDedupeKey({ ...base, kind: "SLIDE_DECK" });
  const legacy = legacyStoredFileDedupeKey({ ...base, kind: "SLIDE_DECK" });
  assert.equal(legacy.sha256, "abcdef");
  assert.notEqual(scoped.sha256, legacy.sha256);
  assert.notDeepEqual(
    scoped,
    storedFileDedupeKey({ ...base, uploaderUserId: "another-speaker", kind: "SLIDE_DECK" }),
  );
});
