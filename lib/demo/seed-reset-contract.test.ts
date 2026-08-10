import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const seedSource = readFileSync(new URL("./seed.ts", import.meta.url), "utf8");

test("demo reset clears every post-seed event-scoped transient table", () => {
  for (const delegate of [
    "reviewerInvite",
    "publicSubmissionRateBucket",
    "importJob",
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
});
