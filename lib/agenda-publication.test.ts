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
