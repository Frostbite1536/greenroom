import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const smoke = readFileSync(new URL("./_smoke.mjs", import.meta.url), "utf8");

test("C17 smoke fixtures use Prisma-managed ReviewerInvite timestamps", () => {
  assert.match(smoke, /prisma\.reviewerInvite\.create\(/);
  assert.match(smoke, /prisma\.reviewerInvite\.update\(/);
  assert.doesNotMatch(smoke, /(?:INSERT INTO|UPDATE) "ReviewerInvite"/);
  assert.match(smoke, /resendAvailableAt/);
});

test("the invite link reveal smoke covers authority, scope, round-trip, and non-persistence", () => {
  assert.match(smoke, /"\/api\/evaluations\/reviewer-invites\/link", \{ email: c17Email \}, admin\)/);
  // ADMIN-only and event-scoped: evaluator/speaker/anonymous and another
  // event's reviewer are all refused.
  assert.match(smoke, /\{ email: c17Email \}, evalr\)/);
  assert.match(smoke, /\{ email: c17Email \}, speaker\)/);
  assert.match(smoke, /\{ email: "reviewer-cross-event@scratch\.test" \}, admin\)/);
  assert.match(smoke, /c17RevealExpired\.status === 404/);
  assert.match(smoke, /c17Reveal\.headers\.get\("cache-control"\) === "no-store"/);
  // The revealed fragment round-trips through the real acceptance path exactly
  // once, and the consumed invite can no longer be revealed.
  assert.match(smoke, /postReviewerInviteAccept\(c17RevealedToken\)/);
  assert.match(smoke, /c17RevealReplay\.status === 404/);
  assert.match(smoke, /c17RevealAfterAccept\.status === 404/);
  assert.match(smoke, /!c17RevealPersisted/);
});

test("the invite link reveal smoke asserts bearer shape and never prints the bearer", () => {
  const reveal = smoke.slice(smoke.indexOf("const c17RevealBefore"), smoke.indexOf("const c17Template ="));
  assert.ok(reveal.length > 0);
  assert.match(reveal, /\/\^\[A-Za-z0-9_-\]\{43\}\$\//);
  assert.match(reveal, /c17RevealedUrl\.startsWith\(c17RevealPrefix\)/);
  // No check detail, log, or error line may carry the revealed value itself.
  assert.doesNotMatch(reveal, /console\./);
  assert.doesNotMatch(reveal, /\$\{c17Revealed(?:Url|Token)\}/);
  assert.doesNotMatch(reveal, /c17Revealed(?:Url|Token)\s*\)\s*,\s*$/m);
});
