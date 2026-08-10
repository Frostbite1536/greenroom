import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("reviewer invite acceptance strips a sensitive fragment before body-only fetch and fixed-path navigation", () => {
  const accept = source("components/reviewer-invite-accept.tsx");
  assert.match(accept, /useLayoutEffect\(\(\) => \{[\s\S]*?stripReviewerInviteFragment\(\)/);
  assert.match(accept, /if \(!fragment\.safeToRequest\)[\s\S]*?return;/);
  assert.match(accept, /body: JSON\.stringify\(\{ token \}\)/);
  assert.match(accept, /cache: "no-store"/);
  assert.match(accept, /referrerPolicy: "no-referrer"/);
  assert.match(accept, /finalUrl\.origin === window\.location\.origin[\s\S]*?finalUrl\.pathname === "\/admin\/evaluations"/);
  assert.match(accept, /router\.replace\("\/admin\/evaluations"\)/);
  assert.doesNotMatch(accept, /router\.replace\(response\.url\)/);
  assert.doesNotMatch(accept, /(?:localStorage|sessionStorage|URLSearchParams\(window\.location\.search\))/);
  assert.doesNotMatch(accept, /reviewer-invites\/accept\?[^\n]*/);
});

test("reviewer invite diagnostics have bounded labels and never interpolate bearer material", () => {
  const accept = source("components/reviewer-invite-accept.tsx");
  const smoke = source("scripts/_frontend-smoke.mjs");
  assert.match(accept, /console\.error\("Reviewer invite history strip failed", error\);/);
  assert.match(accept, /console\.error\("Reviewer invite acceptance request failed", error\);/);
  assert.match(
    accept,
    /console\.error\(\s*"Reviewer invite redirect validation failed",\s*error instanceof Error \? error\.name : "unknown",\s*\);/,
  );
  assert.match(
    smoke,
    /console\.warn\("\[smoke\] postManual JSON parse failed", error instanceof Error \? error\.name : "unknown"\);/,
  );
  assert.doesNotMatch(accept, /Reviewer invite redirect validation failed",\s*(?:response|finalUrl|token|body|error\.message)/);
  assert.doesNotMatch(smoke, /postManual JSON parse failed",\s*(?:text|path|body|token|res|error\.message)/);
  assert.doesNotMatch(accept, /console\.error\([^;]*(?:token|window\.location|response\.url|body)/);
});

test("the admin setup projection is bounded and evaluator output cannot receive reviewer invitation data", () => {
  const reads = source("lib/data/reads.ts");
  const page = source("app/(app)/admin/evaluations/page.tsx");
  assert.match(reads, /pageContext\(\["ADMIN"\]\)/);
  assert.match(reads, /take: OPERATOR_QUERY_LIMITS\.reviewerSetupMembers \+ 1/);
  assert.match(reads, /assertEventQueryBound\(members, OPERATOR_QUERY_LIMITS\.reviewerSetupMembers/);
  assert.match(reads, /assertEventQueryBound\(invites, OPERATOR_QUERY_LIMITS\.reviewerSetupMembers/);
  assert.match(reads, /where: \{ eventId: ctx\.eventId, userId: \{ in: memberUserIds \} \}/);
  assert.match(page, /if \(view\.role === "ADMIN"\) \{[\s\S]*?getEvaluationSetup\(\)/);
  assert.doesNotMatch(page, /if \(view\.role !== "ADMIN"\)[\s\S]*?getEvaluationSetup\(\)/);
});

test("the approved inline form remains labelled and resend stays outside the reviewer checkbox label", () => {
  const setup = source("components/evaluation-setup.tsx");
  const controls = source("components/reviewer-invite-controls.tsx");
  assert.match(setup, /<ReviewerInviteForm \/>/);
  assert.match(setup, /<ReviewerInviteResend reviewer=\{e\} \/>/);
  assert.match(controls, /<form className="reviewer-invite"[\s\S]*?autoComplete="name"[\s\S]*?autoComplete="email"/);
  assert.match(controls, /role="status"/);
  assert.match(controls, /role="alert"/);
  assert.match(controls, /They get reviewer access for this event and can start reviewing after they accept the invitation\./);
});

test("a stale-page resend cooldown refreshes authoritative availability without a permanent client latch", () => {
  const controls = source("components/reviewer-invite-controls.tsx");
  assert.doesNotMatch(controls, /cooldownDenied/);
  assert.match(
    controls,
    /res\.error\.code === "INVITE_RESEND_COOLDOWN"[\s\S]*?startTransition\(\(\) => router\.refresh\(\)\)/,
  );
  // The cooldown must name when it clears rather than read as permanent.
  assert.doesNotMatch(controls, /Resend is not available yet/);
  assert.match(controls, /reviewerInviteResendHint\(resendAt, now\)/);
  assert.match(controls, /<time dateTime=\{resendAt\}>\{resendHint\}<\/time>/);
});

test("the admin invite controls copy a revealed bearer without storing, logging, or navigating it", () => {
  const controls = source("components/reviewer-invite-controls.tsx");
  assert.match(controls, /apiPost<ReviewerInviteLinkResult>\("\/api\/evaluations\/reviewer-invites\/link", \{ email \}\)/);
  // Success is claimed only after the clipboard write resolves, and a rejected
  // or unavailable Clipboard API falls back to a selected field for manual copy.
  assert.match(controls, /await navigator\.clipboard\.writeText\(url\);\s*setCopyState\("copied"\);/);
  assert.match(controls, /if \(!navigator\.clipboard\?\.writeText\) throw new Error\("clipboard unavailable"\)/);
  assert.match(controls, /setCopyState\("manual"\);\s*linkField\.current\?\.focus\(\);\s*linkField\.current\?\.select\(\);/);
  assert.match(controls, /press Ctrl\/Cmd \+ C/);
  // The bearer stays in component state: never storage, never a URL, never a log.
  assert.doesNotMatch(controls, /localStorage|sessionStorage|document\.cookie|window\.location|router\.push|router\.replace/);
  assert.match(
    controls,
    /console\.warn\("Reviewer invite link copy failed", error instanceof Error \? error\.name : "unknown"\)/,
  );
  // No console call may pass the bearer-bearing value itself as an argument.
  assert.doesNotMatch(controls, /console\.[a-z]+\([^)]*\b(?:url|link|inviteUrl|token|res\.data)\b\s*[,)]/);
  // A rotated, accepted, or expired invitation drops any link still on screen.
  assert.match(controls, /setLink\(null\);\s*setCopyState\("idle"\);\s*\}, \[resendAt, inviteExpiresAt, invite\?\.state\]\)/);
});

test("only the reveal endpoint and the outgoing email ever materialize an invite URL", () => {
  // Every listing projection stays token-free; a bearer is derived on demand
  // for one authorized ADMIN response and for the rendered invitation only.
  for (const path of ["lib/data/reads.ts", "app/api/evaluations/evaluators/route.ts"]) {
    assert.doesNotMatch(source(path), /createReviewerInviteToken|reviewerInviteUrl|inviteUrl/, path);
  }
  const postRoute = source("app/api/evaluations/reviewer-invites/route.ts");
  assert.match(postRoute, /inviteUrl: reviewerInviteUrl\(appUrl, planned\.delivery\.token\)/);
  assert.doesNotMatch(postRoute, /return ok\(\{[^}]*inviteUrl/);
});
