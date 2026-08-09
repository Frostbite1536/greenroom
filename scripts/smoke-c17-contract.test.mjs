import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const smoke = readFileSync(new URL("./_smoke.mjs", import.meta.url), "utf8");

test("C17 smoke fixtures use Prisma-managed ReviewerInvite timestamps", () => {
  assert.match(smoke, /prisma\.reviewerInvite\.create\(/);
  assert.match(smoke, /prisma\.reviewerInvite\.update\(/);
  assert.doesNotMatch(smoke, /(?:INSERT INTO|UPDATE) "ReviewerInvite"/);
});
