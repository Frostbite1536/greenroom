import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { publicationControl, unpublishedNotice } from "./agenda-publication";

test("a published talk offers to unpublish, and says what that costs first", () => {
  const control = publicationControl("PUBLISHED");
  assert.equal(control.next, "DRAFT");
  assert.equal(control.label, "Unpublish");
  assert.equal(control.actionLabel("Scaling to 10M"), "Unpublish Scaling to 10M from the public programme");
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
  assert.equal(control.actionLabel("Scaling to 10M"), "Publish Scaling to 10M to the public programme");
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
  // The submission half is deliberately untouched: `contentStatus` says nothing
  // about an abstract, and gating it there would hide real submissions.
  assert.match(speakers, /const eventAbstractSpeakers = \{ abstract: \{ eventId: event\.id \} \}/);
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
  const route = source("app/api/evaluations/decisions/route.ts");
  assert.match(route, /sessionPublicationForDecision\(input\.decision\)/);
  assert.match(route, /data: \{ contentStatus: publication \}/);
  assert.ok(route.indexOf("lockAbstractForWrite") < route.indexOf("sessionPublicationForDecision"));
  // Scoped to the abstract's own session id, never a broader write.
  assert.match(route, /where: \{ id: provisioned\.sessionId \}/);
});

test("past the cap, the unpublished count is a floor and says the page is partial", () => {
  const notice = unpublishedNotice(["DRAFT", "PUBLISHED", "DRAFT"], true) ?? "";
  assert.match(notice, /At least 2 talks are unpublished/);
  assert.match(notice, /does not hold the whole programme/);
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
