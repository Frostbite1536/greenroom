import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { speakerProfileLockKey } from "./speaker-roster";

/**
 * GRA-05, server half. `SpeakerProfile` is one global row per person, and it has
 * exactly two request-path writers: the organizer's roster editor
 * (`/api/admin/speakers`) and the speaker's own portal (`/api/portal/profile`).
 * The admin route has always taken a per-user advisory lock before touching the
 * row; the portal route did not, so the two could interleave a read-modify-write
 * on the same row and race to its unique `userId`.
 *
 * Both must serialize on the SAME key, so this pins the key's identity as well
 * as its use. Source assertions are CRLF-safe: no pattern crosses a line break.
 */
const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const portal = source("app/api/portal/profile/route.ts");
const admin = source("app/api/admin/speakers/route.ts");

test("the lock key is derived from the user alone, so both writers name the same row", () => {
  // Not event-scoped: the row is global, so an event-scoped key would let an
  // organizer and the speaker hold two different locks over one row.
  assert.equal(speakerProfileLockKey("user-1"), "speaker-profile:user-1");
  assert.notEqual(speakerProfileLockKey("user-1"), speakerProfileLockKey("user-2"));
});

test("the portal profile write takes the shared speaker-profile lock", () => {
  assert.match(portal, /import \{ lockSpeakerProfile \} from "@\/lib\/services\/speaker-roster"/);
  assert.match(portal, /prisma\.\$transaction\(async \(tx\) => \{/);
  assert.match(portal, /await lockSpeakerProfile\(tx, user\.id\)/);
});

test("the lock is taken before the upsert, not alongside it", () => {
  assert.ok(
    portal.indexOf("lockSpeakerProfile(tx, user.id)") < portal.indexOf("tx.speakerProfile.upsert"),
    "the advisory lock must precede the write it serializes",
  );
});

test("the portal write happens on the transaction client, never the loose one", () => {
  // `prisma.speakerProfile.upsert` outside the transaction would take the lock
  // and then write on a different connection, serializing nothing.
  assert.doesNotMatch(portal, /prisma\.speakerProfile\.upsert/);
  assert.match(portal, /const profile = await tx\.speakerProfile\.upsert\(\{/);
});

test("the per-event deck association is written inside the same transaction", () => {
  // The association is a second write in the same save. On its own connection
  // it could land while the profile write rolled back, leaving the speaker
  // looking at a fallback deck they believe they replaced.
  assert.doesNotMatch(portal, /prisma\.eventSpeakerDeck\./);
  for (const write of ["tx.eventSpeakerDeck.upsert(", "tx.eventSpeakerDeck.deleteMany("]) {
    const at = portal.indexOf(write);
    assert.ok(at > 0, `${write} must exist`);
    assert.ok(portal.indexOf("lockSpeakerProfile(tx, user.id)") < at, `${write} must follow the lock`);
  }
  // One transaction for the whole save, not one per write.
  assert.equal(portal.split("prisma.$transaction(").length - 1, 1);
});

test("the admin roster editor still takes the same lock, so the pair is closed", () => {
  assert.match(admin, /lockSpeakerProfile\(tx, user\.id\)/);
  assert.match(admin, /lockSpeakerProfile\(tx, userId\)/);
  // Neither route may write the row without holding it.
  for (const route of [portal, admin]) {
    assert.ok(
      (route.match(/speakerProfile\.upsert/g) ?? []).length
        <= (route.match(/lockSpeakerProfile\(/g) ?? []).length,
      "every SpeakerProfile write needs a lock acquisition of its own",
    );
  }
});

test("the portal route still refuses a bad body before opening a transaction", () => {
  // Validation and identity resolution stay outside the lock: holding a
  // database lock while rejecting garbage would let an unauthenticated caller
  // queue behind a real speaker's save.
  // Named explicitly rather than pattern-matched: an `indexOf` on a schema name
  // that no longer appears returns -1, which is silently "before" everything.
  const validate = portal.indexOf("portalProfileUpdateSchema.safeParse");
  assert.ok(validate > 0, "the portal route must validate with the portal's own schema");
  assert.ok(validate < portal.indexOf("$transaction"));
  assert.ok(portal.indexOf("resolveSessionUser(session)") < portal.indexOf("$transaction"));
  assert.match(portal, /return fail\("VALIDATION_ERROR", "Profile details are invalid\.", 422/);
});
