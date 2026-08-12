import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Source contract for `POST /api/assistant/decision-note`.
 *
 * Deliberately narrow. The route's positive behaviour — its authorization, its
 * scoped 404, its exact `select`, its exact prompt, its structured-output
 * validation and its response — is proven by driving the real handler in
 * `decision-note-route.test.ts`, which is a far stronger claim than a regex
 * over the file.
 *
 * What is left here is the negative space, which runtime tests cannot show:
 * things this route must never acquire. A lock, a write, a log line, an import
 * of the email builder — each would pass every behavioural test in the suite
 * while breaking a guarantee the feature was accepted on.
 *
 * Source assertions are CRLF-safe: no pattern below crosses a line break.
 */
const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/** Comment text stripped, so "this file says X" is asserted against code. */
const code = (path: string) =>
  source(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\r\n]*/g, "$1");

const ROUTE = "app/api/assistant/decision-note/route.ts";
const route = () => code(ROUTE);

test("the route writes nothing and locks nothing", () => {
  const it = route();
  // Advisory and read-only, per the assessment's concurrency section: the
  // authoritative boundary stays the email preview proof, not a lock here.
  for (const write of [
    /lockAbstractForWrite/,
    /abstract-lock/,
    /\$transaction/,
    /\.create\(/,
    /\.update\(/,
    /\.delete\(/,
    /\.upsert\(/,
  ]) {
    assert.doesNotMatch(it, write, `the drafting route must not ${write}`);
  }
  // Exactly two reads reach Prisma, and both are the injected ones.
  assert.equal((it.match(/prisma\./g) ?? []).length, 2, "no third database call");
  assert.match(it, /prisma\.abstract\.findUnique/);
  assert.match(it, /prisma\.reviewScore\.findMany/);
});

test("no path from a drafted note reaches a mailbox or the preview proof", () => {
  // Drafting is not sending. A decision email is rendered, previewed, and sent
  // only against an HMAC proof of that exact content and recipient list, which
  // this route cannot satisfy and must not try to.
  const EMAIL_SURFACE =
    /dispatchEmail|emailDispatch|EmailDispatch|deliverEmail|buildDecisionEmail|issueDecisionPreviewToken|previewToken|contentDigest|@\/lib\/comms\//;
  assert.doesNotMatch(route(), EMAIL_SURFACE);
  // Non-vacuity: the regex really does fire on the file that legitimately
  // sends, so the assertion above is not passing because it matches nothing.
  assert.match(code("app/api/comms/decision/route.ts"), EMAIL_SURFACE);
});

test("the route logs nothing, and the shared contract file is untouched", () => {
  const it = route();
  assert.doesNotMatch(it, /console\./, "a prompt or draft must never reach a log line");
  assert.doesNotMatch(it, /@\/types\/api/, "the assistant contract stays assistant-local");
  // Non-vacuity for the types/api claim: the route that legitimately uses the
  // shared contract does import it, so this pattern really does fire.
  assert.match(code("app/api/evaluations/decisions/bulk/route.ts"), /@\/types\/api/);
});

test("no deterministic stand-in can be substituted for a generation", () => {
  const it = route();
  // The forbidden fallback, asserted by absence. Greenroom's deterministic
  // email template exists elsewhere and must not be dressed up as a draft.
  for (const fallback of [/buildDecisionEmail/, /fallback/i, /draft: "/, /draft: `/]) {
    assert.doesNotMatch(it, fallback, `the route must not substitute ${fallback} for a generation`);
  }
  // The only draft it can return is the one it validated.
  assert.match(it, /ok\(\{ draft: parsed\.draft, grounding \}\)/);
  assert.match(it, /if \(!parsed\.ok\) throw decisionNoteUnavailable\(parsed\.reason\);/);
});

test("the body is read through the bounded reader, never the unbounded one", () => {
  const it = route();
  assert.match(it, /parseBoundedJson\(req, decisionNoteRequestSchema, DECISION_NOTE_MAX_BODY_BYTES\)/);
  assert.doesNotMatch(it, /parseBody\(/, "the unbounded reader must not come back");
  // Non-vacuity: `parseBody` is what other routes use, so the name is real.
  assert.match(code("app/api/comms/decision/route.ts"), /parseBody\(/);
});

test("the generated note is never cached by anything between here and the browser", () => {
  assert.match(route(), /response\.headers\.set\("Cache-Control", "no-store"\)/);
});

test("the decision email's preview proof is untouched by this feature", () => {
  // The assistant is advisory; the send gate is not. Both halves of the proof
  // still live in the email route exactly as they did.
  const email = code("app/api/comms/decision/route.ts");
  assert.match(email, /createHash\("sha256"\)/);
  assert.match(email, /contentDigest,/);
  assert.match(email, /issueDecisionPreviewToken\(previewIdentity, signingSecret\)/);
  assert.match(email, /verifyDecisionPreviewToken\(input\.previewToken, previewIdentity, signingSecret\)/);
  assert.match(email, /"PREVIEW_REQUIRED",/);
  // The digest still covers the rendered messages, which carry the personal
  // note — so an applied or edited draft invalidates a prior preview server
  // side, not merely in the panel's state.
  assert.match(email, /\.update\(JSON\.stringify\(renderedMessages\)\)/);
  assert.match(email, /personalNote: input\.personalNote,/);
});

test("US spelling, matching the rest of the reader-facing text", () => {
  for (const path of [ROUTE, "lib/assistant/decision-note.ts", "lib/decision-note-ui.ts", "e2e/assistant-decision-note.spec.ts"]) {
    assert.doesNotMatch(source(path), /programme/i, `${path} must use the US "program"`);
  }
  assert.match(source("lib/assistant/decision-note.ts"), /say what the program valued/);
});

test("the browser proof uses the suite-owned provider rather than a spec-owned listener", () => {
  const spec = source("e2e/assistant-decision-note.spec.ts");
  assert.doesNotMatch(spec, /node:http|createServer|\.listen\(|E2E_ASSISTANT_STUB/);
  assert.match(spec, /\/_control\/decision/);
  assert.match(spec, /configureStub\(\["slow"\]\)/);
  assert.match(spec, /configureStub\(\["server-error", "server-error"\]\)/);
  assert.match(spec, /capture\.authorizationOwned/);
});
