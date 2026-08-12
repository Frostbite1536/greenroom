import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const seedSource = readFileSync(new URL("./seed.ts", import.meta.url), "utf8");

test("demo reset clears every post-seed event-scoped transient table", () => {
  for (const delegate of [
    "reviewerInvite",
    "publicSubmissionRateBucket",
    "importJob",
    "apiCredential",
    "eventSpeakerDeck",
  ]) {
    assert.match(
      seedSource,
      new RegExp(`db\\.${delegate}\\.deleteMany\\(\\{ where: \\{ eventId \\} \\}\\)`),
      `${delegate} must not survive an idempotent demo reset`,
    );
  }

  assert.ok(
    seedSource.indexOf("db.reviewerInvite.deleteMany") <
      seedSource.indexOf("db.eventMember.deleteMany"),
    "reviewer invitations must be removed before demo memberships are rebuilt",
  );

  assert.match(
    seedSource,
    /db\.abstractAttachment\.deleteMany\(\{ where: \{ abstract: \{ eventId \} \} \}\)/,
    "proposal attachment links must not survive the proposal reset",
  );
  assert.ok(
    seedSource.indexOf("db.abstractAttachment.deleteMany") <
      seedSource.indexOf("db.abstract.deleteMany"),
    "attachment links must be removed before their proposals",
  );
});
