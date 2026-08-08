import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("public CFP creates speaker data without granting membership or overwriting identities", () => {
  const submissionRoute = source("app/api/cfp/submissions/route.ts");
  assert.match(submissionRoute, /tx\.user\.upsert\([\s\S]*?update:\s*\{\}/);
  assert.doesNotMatch(submissionRoute, /eventMember|ensureSpeakerMemberships/);
});

test("login exposes only fixed demo persona actions", () => {
  const actions = source("app/login/actions.ts");
  const page = source("app/login/page.tsx");
  assert.doesNotMatch(actions, /loginWithEmail|@\/lib\/prisma/);
  assert.doesNotMatch(page, /loginWithEmail|login-email-form|name="email"/);
  assert.match(page, /loginAsPersona/);
});

test("reset returns generic failures while logging only safe error context", () => {
  const resetRoute = source("app/api/admin/reset/route.ts");
  assert.match(resetRoute, /console\.error\("\[reset\]/);
  assert.doesNotMatch(resetRoute, /error\.(?:message|stack)|req(?:uest)?\.(?:headers|cookies|body)/);
  assert.match(resetRoute, /AUTH_UNAVAILABLE/);
  assert.match(resetRoute, /RESET_FAILED/);
});
