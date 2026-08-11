import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BULK_ABSTRACT_DECISION_LIMIT, bulkAbstractDecisionSchema } from "@/types/api";

/**
 * G7 — source contract for `POST /api/evaluations/decisions/bulk`.
 *
 * Four claims about this route are the whole feature, and none of them is
 * observable from the response body alone:
 *
 *  1. It loops the existing locked decision write; it does not reimplement it.
 *  2. Each abstract gets its own transaction, never one spanning the batch.
 *  3. It is admin-only and event-scoped.
 *  4. It sends no email, and cannot start to without this test failing.
 *
 * (4) is the one that most needs pinning by absence. An email import added here
 * later would work, would pass every behavioural test, and would mail a hundred
 * speakers the first time an organizer used the button — bypassing the preview
 * gate that binds a decision email to the exact content an admin looked at.
 *
 * Source assertions are CRLF-safe: no pattern below crosses a line break.
 */
const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/** Comment text stripped, so "this file says X" is asserted against code. */
const code = (path: string) =>
  source(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\r\n]*/g, "$1");

const bulkRoute = () => code("app/api/evaluations/decisions/bulk/route.ts");
const singleRoute = () => code("app/api/evaluations/decisions/route.ts");
const writer = () => code("lib/services/abstract-decision-write.ts");
const orchestrator = () => code("lib/services/bulk-abstract-decision.ts");

test("the bulk route is admin-only and scoped to the caller's own event", () => {
  const route = bulkRoute();
  assert.match(route, /requireContext\(\["ADMIN"\]\)/);
  // The event is read from the session, never from the body: a body-supplied
  // eventId would let an admin of one event decide another's proposals.
  assert.match(route, /eventId: ctx\.eventId/);
  assert.doesNotMatch(route, /eventId:\s*input\./);
  assert.doesNotMatch(code("types/api.ts").slice(
    code("types/api.ts").indexOf("export const bulkAbstractDecisionSchema"),
    code("types/api.ts").indexOf("export const abstractToSessionSchema"),
  ), /eventId/);
});

test("the bulk route loops the locked decision write instead of reimplementing it", () => {
  const route = bulkRoute();
  // The one write function, imported from the service both routes share.
  assert.match(route, /import \{ writeAbstractDecision \} from "@\/lib\/services\/abstract-decision-write";/);
  assert.match(route, /writeAbstractDecision\(tx, \{/);
  assert.match(route, /runBulkAbstractDecision\(input\.decision, input\.abstractIds, \(abstractId\) =>/);

  // And it re-derives none of the decision's own rules. Every one of these is a
  // step of the locked path; seeing any of them here would mean a second,
  // drifting copy of the accept semantics.
  for (const bypass of [
    /lockAbstractForWrite/,
    /provisionAcceptedAbstract/,
    /assignOnboardingTasks/,
    /tx\.abstract\.update/,
    /tx\.session\.(create|update)/,
    /decidedAt/,
    /contentStatus/,
    /canAdminDecide/,
    /sessionPublicationForDecision/,
  ]) {
    assert.doesNotMatch(route, bypass, `the bulk route must not reimplement ${bypass}`);
  }

  // The shared writer is the thing that still does all of it, under the lock.
  const write = writer();
  assert.match(write, /await lockAbstractForWrite\(tx, input\.abstractId\);/);
  assert.match(write, /provisionAcceptedAbstract\(tx, decided\)/);
  // Lock first, always: the status read that follows must not be able to go
  // stale between the check and the write (INV-ABSTRACT-001).
  assert.ok(
    write.indexOf("lockAbstractForWrite") < write.indexOf("tx.abstract.findUnique"),
    "the advisory lock must precede the status read",
  );
  assert.ok(
    write.indexOf("tx.abstract.findUnique") < write.indexOf("tx.abstract.update"),
    "the status must be re-read under the lock before the write",
  );
});

test("one transaction per abstract, never one spanning the batch", () => {
  const route = bulkRoute();
  // The transaction opens INSIDE the per-item callback the orchestrator calls,
  // so each abstract commits or rolls back alone. A batch-wide transaction
  // would hold every selected abstract's advisory lock against concurrent
  // speaker edits until the slowest provisioning finished, and would discard
  // every correct write to report one refusal.
  const perItem = route.slice(route.indexOf("runBulkAbstractDecision("));
  assert.match(perItem, /prisma\.\$transaction\(\(tx\) =>/);
  assert.equal(
    (route.match(/prisma\.\$transaction/g) ?? []).length,
    1,
    "exactly one $transaction call, and it is the per-item one",
  );
  assert.ok(
    route.indexOf("runBulkAbstractDecision") < route.indexOf("prisma.$transaction"),
    "the loop must wrap the transaction, not the reverse",
  );

  // The orchestrator awaits each item before starting the next, so the batch
  // never holds two of its own advisory locks at once.
  const loop = orchestrator();
  assert.match(loop, /for \(const abstractId of abstractIds\) \{/);
  assert.match(loop, /result = await decideOne\(abstractId\);/);
  assert.doesNotMatch(loop, /Promise\.all|Promise\.allSettled/);
});

test("a failing item is caught per item, so the batch is never all-or-nothing", () => {
  const loop = orchestrator();
  // The try/catch is what converts "this transaction threw" into "this row is
  // skipped", leaving the committed rows committed.
  assert.match(loop, /try \{/);
  assert.match(loop, /\} catch \(error\) \{/);
  assert.match(loop, /reasonCode: "DECISION_FAILED",/);
  assert.match(loop, /continue;/);
  // The raw error is logged, not returned: a database message is not operator
  // copy and must not reach a browser.
  assert.match(loop, /console\.error\("\[bulk-decision\] item failed"/);
  assert.doesNotMatch(loop, /reason: String\(error\)|message: error/);
});

test("the batch is bounded, and the bound refuses the request whole with a 422", () => {
  assert.equal(BULK_ABSTRACT_DECISION_LIMIT, 100);

  const atLimit = Array.from({ length: BULK_ABSTRACT_DECISION_LIMIT }, (_, i) => `abstract-${i}`);
  assert.equal(
    bulkAbstractDecisionSchema.safeParse({ abstractIds: atLimit, decision: "ACCEPTED" }).success,
    true,
  );
  const overLimit = [...atLimit, "abstract-one-too-many"];
  assert.equal(
    bulkAbstractDecisionSchema.safeParse({ abstractIds: overLimit, decision: "ACCEPTED" }).success,
    false,
  );
  // An empty selection is refused too — a batch with nothing in it is a bug in
  // the caller, not an operation with an empty result.
  assert.equal(
    bulkAbstractDecisionSchema.safeParse({ abstractIds: [], decision: "ACCEPTED" }).success,
    false,
  );

  // 422, not 400: the body parsed as JSON and failed validation, which is what
  // `parseBody` -> `fromZod` maps a ZodError to for every route in this repo.
  assert.match(code("lib/api/http.ts"), /new ApiError\(422, "VALIDATION_ERROR"/);
  assert.match(bulkRoute(), /parseBody\(req, bulkAbstractDecisionSchema\)/);

  // The bound applies to the array as SENT, so padding with duplicates cannot
  // buy a larger batch; deduplication happens after `.max()` in the transform.
  const schema = source("types/api.ts");
  const shape = schema.slice(
    schema.indexOf("export const bulkAbstractDecisionSchema"),
    schema.indexOf("export const abstractToSessionSchema"),
  );
  assert.match(shape, /\.min\(1\)\.max\(BULK_ABSTRACT_DECISION_LIMIT\)\.transform\(uniqueIds\)/);
});

test("bulk will not reverse an existing decision, and the single route still will", () => {
  // The gate is asked for by the bulk caller only, so the single-row route's
  // long-standing "a decision is reversible" contract is untouched.
  assert.match(bulkRoute(), /requireAwaitingDecision: true,/);
  assert.doesNotMatch(singleRoute(), /requireAwaitingDecision/);
  assert.match(writer(), /if \(input\.requireAwaitingDecision\) \{/);
  // And the gate runs under the lock, on the status re-read there — not on a
  // status the client sent or a read taken before the lock.
  const write = writer();
  assert.ok(
    write.indexOf("lockAbstractForWrite") < write.indexOf("input.requireAwaitingDecision"),
    "the eligibility gate must run under the advisory lock",
  );
  assert.ok(
    write.indexOf("input.requireAwaitingDecision") < write.indexOf("tx.abstract.update"),
    "the eligibility gate must run before the write",
  );
});

test("the single-row route raises the same refusals it always did", () => {
  const route = singleRoute();
  // The write moved into a service; the route's error surface did not. The
  // status, code and message now come from the table both callers read.
  assert.match(route, /const refusal = ABSTRACT_DECISION_REFUSALS\[result\.refusal\];/);
  assert.match(route, /throw new ApiError\(refusal\.status, result\.refusal, refusal\.message\);/);
  // Its response body is unchanged: the same additive keys the drawer reads.
  assert.match(route, /sessionCreated: provisioned\.created,/);
  assert.match(route, /tasksAssigned: provisioned\.tasksAssigned,/);
  assert.match(route, /topicReconciled: provisioned\.topicReconciled,/);
  // And its final full read still happens inside the same transaction as the
  // write, so the serialized row can never predate the decision it reports.
  assert.ok(route.indexOf("writeAbstractDecision") < route.indexOf("tx.abstract.findUniqueOrThrow"));
  assert.ok(route.indexOf("tx.abstract.findUniqueOrThrow") < route.indexOf("return { abstract: full"));
});

test("no path from a bulk decision reaches a mailbox", () => {
  // The roadmap's word is "preview-safe". Deciding is not mailing: a decision
  // email is rendered, previewed, and sent only against an HMAC proof of that
  // exact content and recipient list (`lib/comms/decision-preview.ts`), which a
  // batch cannot satisfy and must not try to.
  //
  // Asserted by absence across every file in the bulk path, because that is the
  // only shape this regression can take — someone adds one import.
  const EMAIL_SURFACE =
    /dispatchEmail|emailDispatch|EmailDispatch|deliverEmail|buildDecisionEmail|issueDecisionPreviewToken|previewToken|@\/lib\/comms\//;
  for (const [name, read] of [
    ["the bulk route", bulkRoute],
    ["the bulk orchestrator", orchestrator],
    ["the shared decision write", writer],
    ["the bulk toolbar", () => code("components/bulk-decision-bar.tsx")],
    ["the bulk copy", () => code("lib/bulk-decision-confirmation.ts")],
  ] as const) {
    assert.doesNotMatch(read(), EMAIL_SURFACE, `${name} must not reach the email surface`);
  }

  // Non-vacuity: the regex really does fire on the file that legitimately
  // sends, so the assertions above are not passing because it matches nothing.
  assert.match(code("app/api/comms/decision/route.ts"), EMAIL_SURFACE);

  // The single-row decision route never sent mail either, and still does not —
  // moving its write into a shared service must not have changed that.
  assert.doesNotMatch(singleRoute(), EMAIL_SURFACE);

  // The operator-facing copy says so in both tenses, so the guarantee is not
  // only enforced in code an organizer cannot read.
  const copy = source("lib/bulk-decision-confirmation.ts");
  assert.match(copy, /No emails are sent; decision emails remain preview-gated in Operations\./);
  assert.match(copy, /No emails were sent; decision emails remain preview-gated in Operations\./);
});
