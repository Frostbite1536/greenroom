import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { publicationControl, unpublishedNotice } from "./agenda-publication";

test("a published talk offers to unpublish, and says what that costs first", () => {
  const control = publicationControl("PUBLISHED");
  assert.equal(control.next, "DRAFT");
  assert.equal(control.label, "Unpublish");
  assert.equal(control.actionLabel("Scaling to 10M"), "Unpublish Scaling to 10M from the public program");
  // The warning has to be honest in both directions: what stops, and what does not.
  const confirm = control.confirm?.("Scaling to 10M") ?? "";
  assert.match(confirm, /Scaling to 10M/);
  assert.match(confirm, /stays on the schedule/);
  assert.match(confirm, /public agenda/);
});

test("an unpublished talk offers to publish, with nothing to warn about", () => {
  const control = publicationControl("DRAFT");
  assert.equal(control.next, "PUBLISHED");
  assert.equal(control.label, "Publish");
  assert.equal(control.confirm, null);
  assert.equal(control.actionLabel("Scaling to 10M"), "Publish Scaling to 10M to the public program");
});

test("pressing the control twice returns a talk to where it started", () => {
  const first = publicationControl("PUBLISHED").next;
  assert.equal(publicationControl(first).next, "PUBLISHED");
});

test("a fully published programme says nothing rather than reporting a zero", () => {
  assert.equal(unpublishedNotice([]), null);
  assert.equal(unpublishedNotice(["PUBLISHED", "PUBLISHED"]), null);
});

test("held-back talks are counted, and counted in plain language", () => {
  assert.equal(
    unpublishedNotice(["PUBLISHED", "DRAFT"]),
    "1 talk is unpublished and does not appear on the public agenda. Open the List view to publish it.",
  );
  assert.equal(
    unpublishedNotice(["DRAFT", "DRAFT", "PUBLISHED"]),
    "2 talks are unpublished and do not appear on the public agenda. Open the List view to publish them.",
  );
  // The notice has to point at the control, or it reports a problem the
  // organizer cannot act on from where they are standing.
  assert.match(unpublishedNotice(["DRAFT"]) ?? "", /List view/);
});

/**
 * Source-level contract. The publication predicate is the whole feature: a
 * public read that forgets it keeps announcing a talk the organizer withdrew,
 * which is exactly the leak this column exists to close. No pure function can
 * observe that a Prisma `where` clause went missing, and the runtime smoke that
 * would catch it cannot run until the schema window.
 */
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("every unauthenticated programme read filters on PUBLISHED", () => {
  const reads = source("lib/data/reads.ts");
  const publicAgenda = reads.slice(
    reads.indexOf("export const getPublicAgenda"),
    reads.indexOf("export const getPublicSpeakers"),
  );
  const publicSpeakers = reads.slice(reads.indexOf("export const getPublicSpeakers"));
  assert.match(publicAgenda, /session: \{ contentStatus: "PUBLISHED" \}/);
  assert.match(publicSpeakers, /contentStatus: "PUBLISHED"/);
  assert.match(
    source("app/api/agenda/public/route.ts"),
    /session: \{ contentStatus: "PUBLISHED" \}/,
  );
});

/**
 * The toggle is only as good as its least-guarded consumer. These three were
 * missed on the first pass: a downloadable calendar file and two key-protected
 * reads whose key is shared with integrations and evaluators rather than held
 * by the organizer alone, which makes them publicly reachable programme reads.
 */
test("the calendar export cannot hand out an unpublished talk", () => {
  const ics = source("app/api/comms/calendar/route.ts");
  assert.match(ics, /contentStatus: "PUBLISHED"/);
  // The predicate sits in the one query that builds the file, beside the
  // placement check, so a single-session export is gated the same way.
  assert.ok(ics.indexOf("scheduleSlot: { isNot: null }") < ics.indexOf('contentStatus: "PUBLISHED"'));
  assert.ok(ics.indexOf('contentStatus: "PUBLISHED"') < ics.indexOf("const events: IcsEvent[]"));
  // "not scheduled" and "not published" must not be distinguishable, or an
  // anonymous caller can probe for held-back talks. Asserted on the refusal
  // copy itself, not the file — the comments above it say "unpublished" on
  // purpose and are not shipped to anyone.
  const refusals = ics.match(/"[^"]*(?:published|scheduled)[^"]*\."/g) ?? [];
  assert.deepEqual(refusals, [
    '"That session is not on the published schedule."',
    '"No published sessions to export."',
  ]);
  for (const refusal of refusals) {
    assert.doesNotMatch(refusal, /unpublished|DRAFT|held back/i);
  }
});

test("both v1 reads gate the programme on PUBLISHED, counts included", () => {
  const schedule = source("app/api/v1/schedule/route.ts");
  // One `where` feeds findMany and count, so `total` cannot advertise rows the
  // page refuses to return.
  assert.match(schedule, /const where = \{ eventId: event\.id, session: \{ contentStatus: "PUBLISHED" as const \} \}/);
  // Exactly one `where` is declared, and both the page and the count read it.
  assert.deepEqual(schedule.match(/const where =/g)?.length, 1);
  assert.match(schedule, /prisma\.scheduleSlot\.findMany\(\{\s*where,/);
  assert.match(schedule, /prisma\.scheduleSlot\.count\(\{ where \}\)/);

  const speakers = source("app/api/v1/speakers/route.ts");
  assert.match(
    speakers,
    /const eventSessionSpeakers = \{ session: \{ eventId: event\.id, contentStatus: "PUBLISHED" as const \} \}/,
  );
  // The same bound object drives eligibility and the appearance count, so an
  // unpublished talk can neither surface a speaker nor be counted for them.
  assert.deepEqual(speakers.match(/eventSessionSpeakers/g)?.length, 3);
});

/**
 * The submission branch is gated too, and by the *linked session* rather than
 * by the abstract's own status.
 *
 * This replaces a boundary I recorded the wrong way round. I had argued a
 * submission was a separate disclosure axis from a published programme; it is
 * not, when the submission's talk is the thing that was held back. An organizer
 * unpublishing a surprise keynote whose speaker has no other appearance was
 * still finding them listed here, with zero counted appearances — the absence
 * itself pointing at what was hidden.
 */
test("the v1 submission branch qualifies a speaker only by their linked session", () => {
  const speakers = source("app/api/v1/speakers/route.ts");
  // No linked Session at all — accepted-but-unconverted, or still under review.
  // Nothing was withheld because nothing was ever published, so this is the
  // participation case the branch exists for and it stays listed.
  assert.match(speakers, /\{ session: \{ is: null \} \}/);
  // Or a linked Session that is published.
  assert.match(speakers, /\{ session: \{ is: \{ contentStatus: "PUBLISHED" as const \} \} \}/);
  // Expressed in the same shared object as the session branch, so eligibility
  // and the appearance count can never diverge.
  assert.match(speakers, /const eventAbstractSpeakers = \{\s*\n\s*abstract: \{/);
  assert.deepEqual(speakers.match(/eventAbstractSpeakers/g)?.length, 3);
  // The abstract's own status is deliberately NOT the gate: a rejected or
  // withdrawn submission is a different question, owned elsewhere.
  assert.doesNotMatch(speakers, /abstract: \{[\s\S]{0,200}status:/);
});

test("the public speaker gallery has no submission branch to gate", () => {
  // Checked, not assumed: `getPublicSpeakers` derives eligibility from
  // `sessionSpeakers` alone, so the linked-session rule has nothing to attach
  // to there — it is already session-gated end to end. If an abstract branch is
  // ever added, this assertion fails and sends the author to the rule above.
  const reads = source("lib/data/reads.ts");
  const publicSpeakers = reads.slice(reads.indexOf("export const getPublicSpeakers"));
  const body = publicSpeakers.slice(0, publicSpeakers.indexOf("\nexport "));
  assert.doesNotMatch(body, /abstractSpeakers/);
  assert.match(body, /contentStatus: "PUBLISHED"/);
});

test("the reads this slice deliberately leaves on the old contract are still unguarded", () => {
  // Recorded, not fixed: reminder targeting and conflict detection read the
  // programme for operational purposes, not to publish it, and unifying them
  // is C10's predicate work. This test exists so the boundary is a decision
  // somebody can find rather than an oversight — if C10 lands, delete it.
  assert.doesNotMatch(source("lib/comms/reminders.ts"), /contentStatus/);
  assert.doesNotMatch(source("lib/services/schedule.ts"), /contentStatus/);
});

test("the publication route writes only contentStatus, and only inside this event", () => {
  const file = source("app/api/agenda/sessions/route.ts");
  const route = file.slice(file.indexOf("export const PATCH"));
  assert.match(route, /requireContext\(\["ADMIN"\]\)/);
  // The event comes from the signed context; the body may not name one.
  assert.doesNotMatch(file, /eventId:\s*idSchema/);
  assert.match(route, /requireEventOwnedRow\(session, ctx\.eventId, "SESSION_NOT_FOUND"/);
  assert.match(route, /data: \{ contentStatus: input\.contentStatus \}/);
  // Ownership is proven inside the same transaction that performs the write.
  assert.ok(route.indexOf("prisma.$transaction") < route.indexOf("requireEventOwnedRow"));
  assert.ok(route.indexOf("requireEventOwnedRow") < route.indexOf("tx.session.update"));
  // One write, and it carries one field. `title` appears only in the response
  // projection, never in a `data:` payload.
  assert.deepEqual(route.match(/data: \{[^}]*\}/g), ["data: { contentStatus: input.contentStatus }"]);
  for (const forbidden of ["durationMinutes", "scheduleSlot", "delete("]) {
    assert.ok(!route.includes(forbidden), `publication route must not touch ${forbidden}`);
  }
});

test("a reversed decision unpublishes under the same lock that wrote the status", () => {
  // The write lives in the service both decision routes run — the single-row
  // one and the bulk one — so the rule is asserted where it lives. It matters
  // more now: a bulk decline must unpublish every talk it reverses, not merely
  // the first.
  const write = source("lib/services/abstract-decision-write.ts");
  assert.match(write, /sessionPublicationForDecision\(input\.decision\)/);
  assert.match(write, /data: \{ contentStatus: publication \}/);
  assert.ok(write.indexOf("lockAbstractForWrite") < write.indexOf("sessionPublicationForDecision"));
  // Scoped to the abstract's own session id, never a broader write.
  assert.match(write, /where: \{ id: provisioned\.sessionId \}/);

  // And both callers really do reach it, so neither can grow a second
  // publication rule of its own.
  for (const path of [
    "app/api/evaluations/decisions/route.ts",
    "app/api/evaluations/decisions/bulk/route.ts",
  ]) {
    const route = source(path);
    assert.match(route, /writeAbstractDecision\(tx, \{/, path);
    assert.ok(!route.includes("contentStatus"), `${path} must not publish on its own`);
  }
});

test("past the cap, the unpublished count is a floor and says the page is partial", () => {
  const notice = unpublishedNotice(["DRAFT", "PUBLISHED", "DRAFT"], true) ?? "";
  assert.match(notice, /At least 2 talks are unpublished/);
  assert.match(notice, /does not hold the whole program/);
  assert.match(notice, /List view/);
  // Singular still reads as English.
  assert.match(unpublishedNotice(["DRAFT"], true) ?? "", /At least 1 talk is unpublished/);
});

test("a truncated page stays silent about finding none, rather than clearing the event", () => {
  // Zero held-back talks among the rows this page loaded is not a statement
  // about the rows it did not. The truncation banner already explains why.
  assert.equal(unpublishedNotice(["PUBLISHED", "PUBLISHED"], true), null);
});

test("the complete-read copy is unchanged by the truncated branch", () => {
  assert.equal(
    unpublishedNotice(["DRAFT", "PUBLISHED"], false),
    "1 talk is unpublished and does not appear on the public agenda. Open the List view to publish it.",
  );
  // Omitting the flag entirely behaves exactly as before.
  assert.equal(unpublishedNotice(["DRAFT", "PUBLISHED"]), unpublishedNotice(["DRAFT", "PUBLISHED"], false));
});
