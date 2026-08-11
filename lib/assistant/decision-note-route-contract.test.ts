import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Source contract for `POST /api/assistant/decision-note`.
 *
 * Five claims about this route are the whole feature, and none of them is
 * visible in a response body:
 *
 *  1. It is admin-only and scoped to the caller's own event, with the unknown
 *     and the foreign id indistinguishable.
 *  2. It charges the durable throttle BEFORE it reads anything.
 *  3. It loads only the fields the projection is allowed to send — the `select`
 *     is the enforcement, not a filter applied later.
 *  4. It writes nothing and locks nothing.
 *  5. It never fabricates a draft when the provider fails.
 *
 * (3) and (5) are the ones that most need pinning by absence. A widened
 * `select` would leak speaker addresses into a third party's logs and every
 * behavioural test would still pass; a deterministic fallback would pass them
 * too, while quietly telling an organizer a template was a generated draft.
 *
 * Source assertions are CRLF-safe: no pattern below crosses a line break.
 */
const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/** Comment text stripped, so "this file says X" is asserted against code. */
const code = (path: string) =>
  source(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\r\n]*/g, "$1");

const ROUTE = "app/api/assistant/decision-note/route.ts";
const route = () => code(ROUTE);

/**
 * The handler body alone.
 *
 * Every ordering claim below is about where a call sits relative to another,
 * and the import list names all the same symbols earlier in the file — so an
 * `indexOf` over the whole module would compare an import to a call site and
 * silently pass or silently produce an empty slice.
 */
const body = () => {
  const it = route();
  const start = it.indexOf("export const POST");
  assert.ok(start > -1, "the route must export a POST handler");
  return it.slice(start);
};

test("the route is admin-only and takes its event from the session, never the body", () => {
  const it = route();
  assert.match(it, /requireContext\(\["ADMIN"\]\)/);
  assert.match(it, /ctx\.eventId/);
  // A body-supplied event would let an admin of one event draft against
  // another's proposals. The schema is `.strict()`, so one cannot even arrive.
  assert.doesNotMatch(it, /eventId:\s*input\./);
  assert.doesNotMatch(it, /input\.eventId/);
  assert.match(code("lib/assistant/decision-note.ts"), /\.strict\(\)/);
  // Scope is decided by the shared resolver, which the unit tests prove returns
  // an identical 404 for an unknown and a foreign id.
  assert.match(it, /resolveDecisionNoteTarget\(abstract, ctx\.eventId\)/);
  assert.match(it, /if \(!resolved\.ok\) throw resolved\.error;/);
});

test("the throttle is charged before any read, and it is the assistant's own", () => {
  const it = body();
  assert.match(it, /enforceAssistantRateLimit\(\{ userId: ctx\.userId, eventId: ctx\.eventId \}\)/);
  // Order is the property: charging after the lookup would make an unknown id
  // the cheap path and turn the endpoint into a free id oracle.
  assert.ok(
    it.indexOf("requireContext") < it.indexOf("enforceAssistantRateLimit"),
    "authentication must precede the throttle",
  );
  assert.ok(
    it.indexOf("enforceAssistantRateLimit") < it.indexOf("prisma."),
    "the throttle must be charged before the first database read",
  );
  assert.ok(
    it.indexOf("enforceAssistantRateLimit") < it.indexOf("runAssistant"),
    "the throttle must be charged before the provider call",
  );
  // Not a different feature's bucket. Asserted against the whole module,
  // because this claim is about the import rather than the call site.
  assert.match(route(), /from "@\/lib\/services\/assistant-rate"/);
  assert.doesNotMatch(route(), /enforceUploadRateLimit|enforceLoginRateLimit|enforcePublicSubmissionRateLimit/);
});

test("the abstract select loads the four projected fields and nothing adjacent", () => {
  const it = body();
  const select = it.slice(it.indexOf("prisma.abstract.findUnique"), it.indexOf("resolveDecisionNoteTarget"));
  assert.match(select, /select: \{ id: true, eventId: true, title: true, status: true, event: \{ select: \{ name: true \} \} \}/);
  // Everything the decision-email route legitimately loads from the same row,
  // asserted absent here: this endpoint talks to a third party.
  for (const leak of [/submitter/, /speakers/, /email/, /reviewScores/, /_count/, /decidedAt/, /submitterId/]) {
    assert.doesNotMatch(select, leak, `the abstract select must not reach ${leak}`);
  }
});

test("the comment read takes comments only, bounded, and never a reviewer identity", () => {
  const it = body();
  const read = it.slice(it.indexOf("prisma.reviewScore.findMany"), it.indexOf("buildDecisionNoteProjection"));
  assert.match(read, /select: \{ comment: true \},/);
  assert.match(read, /take: DECISION_NOTE_COMMENT_READ_LIMIT,/);
  assert.match(read, /comment: \{ not: null \}/);
  for (const leak of [/reviewerId/, /userId/, /user:/, /score/, /rubric/, /reviewer:/]) {
    assert.doesNotMatch(read, leak, `the comment read must not reach ${leak}`);
  }
  // Scoped to the abstract already proven to belong to the caller's event.
  assert.match(read, /abstractId: input\.abstractId/);
});

test("the route writes nothing and locks nothing", () => {
  const it = body();
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
    /dispatchEmail/,
    /emailDispatch/,
  ]) {
    assert.doesNotMatch(it, write, `the drafting route must not ${write}`);
  }
  // The only durable effect is the rate accounting, which happens inside the
  // shared service rather than here.
  assert.equal((it.match(/prisma\./g) ?? []).length, 2, "exactly two reads, no third database call");
});

test("the prompt is the shared projection's, and the provider gets the capped ask", () => {
  const it = route();
  assert.match(it, /instructions: DECISION_NOTE_INSTRUCTIONS,/);
  assert.match(it, /input: renderDecisionNoteInput\(projection\),/);
  assert.match(it, /maxOutputChars: DECISION_NOTE_MAX_DRAFT_CHARS,/);
  // The route must not assemble a prompt of its own; every field that leaves
  // goes through the tested projection.
  assert.match(it, /buildDecisionNoteProjection\(\{/);
  assert.doesNotMatch(it, /`event_name|`proposal_title|`reviewer_comment/);
  // No tool, no streaming, no structured-output schema: this is prose.
  assert.doesNotMatch(it, /textFormat|tools|stream/);
});

test("a provider failure refuses honestly and never fabricates a note", () => {
  const it = route();
  assert.match(it, /if \(!result\.ok\) throw decisionNoteUnavailable\(result\.reason\);/);
  // The forbidden fallback, asserted by absence: the deterministic email
  // template exists elsewhere and must not be dressed up as a generated draft.
  for (const fallback of [/buildDecisionEmail/, /@\/lib\/comms\//, /fallback/i, /draft: "/, /draft: `/]) {
    assert.doesNotMatch(it, fallback, `the route must not substitute ${fallback} for a generation`);
  }
  // The success body is exactly the assessment's shape.
  assert.match(it, /return ok\(\{ draft: result\.text, grounding \}\);/);
});

test("the route logs nothing, and the shared contract file is untouched", () => {
  const it = route();
  assert.doesNotMatch(it, /console\./, "a prompt or draft must never reach a log line");
  assert.doesNotMatch(it, /@\/types\/api/, "the assistant contract stays assistant-local");
  // Non-vacuity for the types/api claim: the route that legitimately uses the
  // shared contract does import it, so this pattern really does fire.
  assert.match(code("app/api/evaluations/decisions/bulk/route.ts"), /@\/types\/api/);
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
  // And the drafting route cannot issue or verify one.
  assert.doesNotMatch(route(), /PreviewToken|previewToken|contentDigest/);
});
