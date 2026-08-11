import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Source-level contract for the consequence-visible UX slice (D-C5-15 item 2):
 * the acceptance confirmation naming what it built, and the placement refusal
 * naming what it collided with. These are wiring, reuse and byte-identity
 * properties that no unit test over the pure copy functions can observe — a
 * refactor could keep every sentence correct and still stop rendering it, or
 * quietly change the response shape the smoke and existing clients pin.
 *
 * Source assertions are CRLF-safe: no pattern crosses a line break.
 */
const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/** Comment text stripped, so "this file does X" is asserted against code. */
const code = (path: string) =>
  source(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\r\n]*/g, "$1");

const slotsRoute = code("app/api/agenda/slots/route.ts");
const drawer = code("components/abstracts-table.tsx");
const agenda = code("components/agenda-builder.tsx");
const conflictHelpers = code("lib/agenda-conflicts.ts");
const smoke = source("scripts/_frontend-smoke.mjs");

test("the drawer renders the shared confirmation, not an inline verdict", () => {
  assert.match(drawer, /from "@\/lib\/decision-confirmation"/);
  assert.match(drawer, /decisionConfirmation\(\{/);
  // The keys that make it specific must actually be read off the response.
  assert.match(drawer, /sessionCreated: res\.data\?\.sessionCreated/);
  assert.match(drawer, /tasksAssigned: res\.data\?\.tasksAssigned/);
  // The old bare verdicts are gone from the decision path.
  assert.doesNotMatch(drawer, /setNotice\("Accepted\."\)/);
  assert.doesNotMatch(drawer, /"Marked as maybe — it remains in review\."/);
});

test("the refusal is built server-side from the shared copy module", () => {
  assert.match(slotsRoute, /from "@\/lib\/services\/schedule-conflict-copy"/);
  assert.match(slotsRoute, /describeScheduleConflict\(\{/);
  // Named from the conflicting slot's own stored row, never from the request.
  assert.match(slotsRoute, /roomName: slot\.room\.name/);
  assert.match(slotsRoute, /sessionTitle: slot\.session\.title/);
  assert.match(slotsRoute, /timeZone,/);
  // The event's clock, not the server's or the reader's.
  assert.match(slotsRoute, /select: \{ timezone: true \}/);
});

test("naming the collision costs nothing on the success path", () => {
  // The name lookup must sit inside the refusal branch, after the conflict
  // test — not in the `existingSlots` read every placement performs.
  const refusal = slotsRoute.indexOf("conflicts.length > 0 && !force");
  // The CALL site, not the import at the top of the file.
  const lookup = slotsRoute.indexOf("describeScheduleConflict({");
  assert.ok(refusal > 0, "the refusal branch must exist");
  assert.ok(lookup > refusal, "the naming read must be inside the refusal branch");
  // The room/session/speaker join belongs to that branch too.
  assert.ok(slotsRoute.indexOf("room: { select: { name: true } }") > refusal);
  // The hot read stays speaker-ids-only.
  assert.doesNotMatch(slotsRoute, /include: \{ session: \{ include: \{ speakers: \{ select: \{ userId: true \}, room/);
});

test("the pre-existing 409 shape is byte-identical", () => {
  // The exact expression existing consumers and the smoke already pin.
  assert.match(slotsRoute, /conflicts: result\.conflicts\.map\(\(c\) => `\$\{c\.type\}: \$\{c\.message\}`\),/);
  assert.match(slotsRoute, /fail\(409, "SCHEDULE_CONFLICT", "This placement conflicts with an existing slot\."/);
  // The named list is additive and omitted when it resolved nothing, so a
  // client cannot come to depend on its presence.
  assert.match(slotsRoute, /result\.conflictDetails\.length > 0 \? \{ conflictDetails: result\.conflictDetails \}/);
});

test("both refusal surfaces word the same collision identically", () => {
  assert.match(conflictHelpers, /export function conflictSentences\(/);
  // Named list preferred, coded list as the fallback — in that order.
  assert.match(conflictHelpers, /const named = fieldErrors\?\.conflictDetails \?\? \[\];/);
  assert.match(conflictHelpers, /return fieldErrors\?\.conflicts \?\? \[\];/);
  // Neither surface may read the raw field itself any more.
  const rawReads = agenda.match(/fieldErrors\?\.conflicts/g) ?? [];
  assert.equal(rawReads.length, 0, "agenda-builder must go through conflictSentences");
  assert.equal((agenda.match(/conflictSentences\(/g) ?? []).length, 2);
});

test("the agenda's consequential writes all report an outcome", () => {
  // Unschedule: both halves, plus a trigger gate that is not just `pending`.
  assert.match(agenda, /setSlotError\(res\.error\.message\)/);
  assert.match(agenda, /setRowBusyId\(sessionId\)/);
  assert.match(agenda, /disabled=\{busy \|\| busyId !== null\}/);
  // A success notice exists and is a live region, not a silent re-render.
  assert.match(agenda, /className="agenda-notice" role="status"/);
  assert.match(agenda, /was taken off the schedule/);
  assert.match(agenda, /placed on the schedule\./);
});

test("the smoke asserts the named refusal, not merely a non-empty list", () => {
  assert.match(smoke, /fieldErrors\?\.conflictDetails/);
  assert.match(smoke, /Room conflict:/);
  assert.match(smoke, /Speaker conflict:/);
  // Named fields, and the event-local clock.
  assert.match(smoke, /includes\("Hall A"\)/);
  assert.match(smoke, /includes\("Scratch Session A"\)/);
  assert.match(smoke, /includes\("Sofia Marques"\)/);
  assert.match(smoke, /P\[DS\]T/);
  // And that the old shape survived alongside it.
  assert.match(smoke, /startsWith\("ROOM_OVERLAP: "\)/);
});
