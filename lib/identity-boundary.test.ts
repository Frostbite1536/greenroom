import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("public CFP creates speaker data without granting membership or overwriting identities", () => {
  const submissionRoute = source("app/api/cfp/submissions/route.ts");
  assert.match(submissionRoute, /tx\.user\.upsert\([\s\S]*?update:\s*\{\}/);
  assert.doesNotMatch(submissionRoute, /eventMember|ensureSpeakerMemberships/);
});

test("event-scoped CSV import cannot overwrite a shared user identity", () => {
  const importRoute = source("app/api/integrations/import/route.ts");
  assert.match(importRoute, /tx\.user\.upsert\([\s\S]*?update:\s*\{\}/);
  assert.doesNotMatch(importRoute, /update:\s*\{\s*name:\s*item\.speakerName/);
  assert.match(importRoute, /create:\s*\{\s*email:\s*item\.speakerEmail,\s*name:\s*item\.speakerName\s*\}/);
});

/**
 * D-C5-6 supersedes the earlier "the login page has no email field" form of
 * this test. The property it was protecting is unchanged and is asserted
 * directly below: **an address alone never issues a session.** The page now
 * carries an email field, but it posts to the credential route, which issues a
 * session only after `resolveCredentialSession` verifies a stored password.
 */
test("login issues sessions from fixed personas or a verified credential, never from an address alone", () => {
  const actions = source("app/login/actions.ts");
  const page = source("app/login/page.tsx");
  const loginRoute = source("app/api/auth/login/route.ts");

  // The persona action is untouched: no database, no email input, no lookup.
  assert.doesNotMatch(actions, /loginWithEmail|@\/lib\/prisma|name="email"/);
  assert.match(actions, /DEMO_PERSONAS\[key as PersonaKey\]/);
  assert.match(page, /loginAsPersona/);

  // The page's email field is a credential post, not a server action that
  // would trust the submitted address.
  assert.doesNotMatch(page, /loginWithEmail|login-email-form/);
  assert.match(page, /method="post" action="\/api\/auth\/login"/);
  assert.doesNotMatch(page, /action=\{login(?!AsPersona)/);

  // The only session issuance on the credential path is gated on the verified
  // resolver returning a session.
  assert.equal(loginRoute.split("encodeSession(").length - 1, 1);
  assert.match(loginRoute, /if \(!session\) return refuse\(req, formEncoded\);\s*\r?\n\s*return establish\(/);
  assert.match(loginRoute, /resolveCredentialSession\(/);
});

test("reset returns generic failures while logging only safe error context", () => {
  const resetRoute = source("app/api/admin/reset/route.ts");
  assert.match(resetRoute, /console\.error\("\[reset\]/);
  assert.doesNotMatch(resetRoute, /error\.(?:message|stack)|req(?:uest)?\.(?:headers|cookies|body)/);
  assert.match(resetRoute, /AUTH_UNAVAILABLE/);
  assert.match(resetRoute, /RESET_FAILED/);
});
