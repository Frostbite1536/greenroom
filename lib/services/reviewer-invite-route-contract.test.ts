import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { reviewerInviteAcceptSchema, reviewerInviteCreateSchema } from "@/types/api";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("reviewer invite request schemas are strict, bounded, and contain no authority identifiers", () => {
  assert.equal(reviewerInviteCreateSchema.safeParse({ email: "Reviewer@Example.test", name: "Reviewer", resend: false }).success, true);
  assert.equal(reviewerInviteCreateSchema.safeParse({ email: "reviewer@example.test", name: "Reviewer", eventId: "other" }).success, false);
  assert.equal(reviewerInviteCreateSchema.safeParse({ email: `${"a".repeat(245)}@example.test`, name: "Reviewer" }).success, false);
  assert.equal(reviewerInviteCreateSchema.safeParse({ email: "reviewer@example.test", name: "x".repeat(121) }).success, false);
  assert.equal(reviewerInviteAcceptSchema.safeParse({ token: { malformed: true } }).success, true);
});

test("reviewer invite writer preserves the C17 lock order and never overwrites an existing user name", () => {
  const route = source("app/api/evaluations/reviewer-invites/route.ts");
  const action = route.slice(route.indexOf("export const POST"));
  assert.match(route, /requireContext\(\["ADMIN"\]\)/);
  assert.match(route, /trustedReviewerInviteAppUrl\(\)/);
  assert.ok(action.indexOf("lockReviewerInviteEventHour") < action.indexOf('SELECT "id", "name", "slug" FROM "Event"'));
  assert.ok(action.indexOf('SELECT "id", "name", "slug" FROM "Event"') < action.indexOf("lockPublicSubmissionIdentities"));
  assert.ok(action.indexOf("lockPublicSubmissionIdentities") < action.indexOf("tx.user.upsert"));
  assert.ok(action.indexOf("tx.user.upsert") < action.indexOf("lockEventMemberAuthorities"));
  assert.ok(action.indexOf("lockEventMemberAuthorities") < action.indexOf("lockExistingEventMembersForUpdate"));
  assert.ok(action.indexOf("lockExistingEventMembersForUpdate") < action.indexOf('FROM "ReviewerInvite"'));
  assert.ok(action.indexOf("missingRequiredTemplateVariables") < action.indexOf('SELECT COALESCE(SUM("sendWindowCount"), 0)'));
  assert.match(route, /update:\s*\{\}/);
  assert.doesNotMatch(route, /update:\s*\{\s*name:/);
  assert.match(route, /sendWindowCount/);
  assert.match(route, /canReserveReviewerInviteSend/);
  assert.match(route, /sendPlan\.kind === "active"/);
  assert.match(route, /tx\.reviewerInvite\.create\(/);
  assert.match(route, /tx\.reviewerInvite\.update\(/);
  assert.match(route, /prisma\.reviewerInvite\.updateMany\(/);
  assert.doesNotMatch(route, /INSERT INTO "ReviewerInvite"/);
  assert.doesNotMatch(route, /UPDATE "ReviewerInvite"/);
  assert.match(route, /variables:\s*\{ kind: "reviewer_invite", eventName:/);
  assert.doesNotMatch(route, /variables:\s*\{[^}]*inviteUrl/);
});

test("reviewer invite acceptance is POST-only, no-store, structurally verifies before DB, and consumes after membership lock", () => {
  const route = source("app/api/auth/reviewer-invites/accept/route.ts");
  assert.doesNotMatch(route, /export const GET/);
  assert.match(route, /REVIEWER_INVITE_JSON_MAX_BYTES/);
  assert.match(route, /Cache-Control", "no-store/);
  assert.match(route, /Referrer-Policy", "no-referrer/);
  assert.match(route, /trustedReviewerInviteAppUrl\(\)/);
  assert.ok(route.indexOf("trustedReviewerInviteAppUrl") < route.indexOf("prisma.$transaction"));
  assert.ok(route.indexOf("verifyReviewerInviteToken") < route.indexOf("prisma.$transaction"));
  assert.ok(route.indexOf("lockEventMemberAuthorities") < route.indexOf("lockExistingEventMembersForShare"));
  assert.ok(route.indexOf("lockExistingEventMembersForShare") < route.indexOf('FOR UPDATE'));
  assert.match(route, /"INVITE_NOT_FOUND"/);
  assert.match(route, /NextResponse\.redirect\(`\$\{appUrl\}\/admin\/evaluations`, 303\)/);
  assert.doesNotMatch(route, /new URL\("\/admin\/evaluations", req\.url\)/);
  assert.match(route, /httpOnly: true/);
  assert.match(route, /sameSite: "lax"/);
});

test("reviewer setup projection is bounded and does not include a bearer token", () => {
  const route = source("app/api/evaluations/evaluators/route.ts");
  assert.match(route, /take: OPERATOR_QUERY_LIMITS\.reviewerSetupMembers \+ 1/);
  assert.match(route, /assertEventQueryBound\(members, OPERATOR_QUERY_LIMITS\.reviewerSetupMembers/);
  assert.match(route, /lastDeliveryState/);
  assert.doesNotMatch(route, /draftCapability|inviteToken|token:\s/);
});
