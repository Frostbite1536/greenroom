/**
 * W24 — the admin session content editor's contract and write projection.
 *
 * `PATCH /api/agenda/sessions` used to write one field. It now edits a confirmed
 * talk's own content as well, so two things need holding down: that the widened
 * body is a strict superset of the publication toggle's (an old client's request
 * must still mean exactly what it meant), and that a category from another event
 * is refused with the same indistinguishable 404 the taxonomy routes give.
 *
 * Source regexes are CRLF-safe: nothing matches across a line break without
 * allowing an optional `\r`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ApiError } from "@/lib/api/http";
import { requireEventOwnedRow } from "@/lib/services/event-owned-row";
import { sessionUpdateData } from "@/lib/services/session-content-edit";
import { SESSION_UPDATE_FIELDS, sessionPublicationSchema, sessionUpdateSchema } from "@/types/api";

const source = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const SESSION_ID = "session_1";

/* -------------------------------------------------------------------------- */
/* The contract                                                                */
/* -------------------------------------------------------------------------- */

test("every body the publication toggle sent is still accepted, and still means one field", () => {
  for (const contentStatus of ["DRAFT", "PUBLISHED"] as const) {
    const body = { sessionId: SESSION_ID, contentStatus };
    // The old schema still accepts it, and the new one parses it identically.
    assert.equal(sessionPublicationSchema.safeParse(body).success, true);
    const parsed = sessionUpdateSchema.safeParse(body);
    assert.equal(parsed.success, true);
    // And the write it produces is exactly the write it always was.
    assert.deepEqual(sessionUpdateData(parsed.data!), { contentStatus });
  }
});

test("the content fields are accepted together, and only those fields", () => {
  const parsed = sessionUpdateSchema.safeParse({
    sessionId: SESSION_ID,
    title: "  Scaling to 10M  ",
    description: "  What we learned  ",
    format: " Keynote ",
    durationMinutes: 45,
    categoryId: "cat_1",
  });
  assert.equal(parsed.success, true);
  // Trimmed at the boundary, so no surface stores its own whitespace.
  assert.deepEqual(sessionUpdateData(parsed.data!), {
    title: "Scaling to 10M",
    description: "What we learned",
    format: "Keynote",
    durationMinutes: 45,
    categoryId: "cat_1",
  });
});

test("the roster and the schedule are not fields on this contract", () => {
  // INV-EDIT-001: the speaker roster is locked once a Session exists, and
  // placement belongs to /api/agenda/slots. Strict, so both are hard refusals
  // rather than silently ignored keys.
  for (const extra of [
    { speakers: [{ userId: "user_1", isPrimary: true }] },
    { speakerIds: ["user_1"] },
    { eventId: "event_1" },
    { startsAt: "2026-05-01T09:00:00.000Z" },
    { roomId: "room_1" },
    { trackId: "track_1" },
    { sourceAbstractId: "abstract_1" },
  ]) {
    const parsed = sessionUpdateSchema.safeParse({ sessionId: SESSION_ID, title: "A talk", ...extra });
    assert.equal(parsed.success, false, `${Object.keys(extra)[0]} must be refused`);
  }
});

test("a body that names nothing to change is refused before it can bump updatedAt", () => {
  const parsed = sessionUpdateSchema.safeParse({ sessionId: SESSION_ID });
  assert.equal(parsed.success, false);
  assert.deepEqual(
    parsed.error!.issues.map((issue) => [issue.path.join("."), issue.message]),
    [["", "Name at least one field to change."]],
  );
});

test("each field can be patched alone, and the others stay untouched", () => {
  const cases: [Record<string, unknown>, Record<string, unknown>][] = [
    [{ title: "New title" }, { title: "New title" }],
    [{ description: "New summary" }, { description: "New summary" }],
    [{ format: "Workshop" }, { format: "Workshop" }],
    [{ durationMinutes: 5 }, { durationMinutes: 5 }],
    [{ categoryId: "cat_2" }, { categoryId: "cat_2" }],
    [{ contentStatus: "DRAFT" }, { contentStatus: "DRAFT" }],
  ];
  for (const [body, expected] of cases) {
    const parsed = sessionUpdateSchema.safeParse({ sessionId: SESSION_ID, ...body });
    assert.equal(parsed.success, true, JSON.stringify(body));
    assert.deepEqual(sessionUpdateData(parsed.data!), expected);
  }
  // Nothing is missing from that list: every field the contract names is
  // patchable on its own, so a new one cannot be added without a case here.
  assert.deepEqual(
    [...SESSION_UPDATE_FIELDS].sort(),
    cases.map(([body]) => Object.keys(body)[0]).sort(),
  );
});

test("clearing the optional text is expressible, and a blank field is not a blank string", () => {
  for (const cleared of [null, "", "   "]) {
    const parsed = sessionUpdateSchema.safeParse({
      sessionId: SESSION_ID,
      description: cleared,
      format: cleared,
    });
    assert.equal(parsed.success, true, JSON.stringify(cleared));
    assert.deepEqual(sessionUpdateData(parsed.data!), { description: null, format: null });
  }
});

test("the bounds are the ones the create contract already enforces", () => {
  const bad: [string, Record<string, unknown>][] = [
    ["a two-character title", { title: "ab" }],
    ["a title past 180 characters", { title: "x".repeat(181) }],
    ["a summary past 5000 characters", { description: "x".repeat(5001) }],
    ["a format past 80 characters", { format: "x".repeat(81) }],
    ["a talk shorter than 5 minutes", { durationMinutes: 4 }],
    ["a talk longer than 8 hours", { durationMinutes: 481 }],
    ["a fractional length", { durationMinutes: 30.5 }],
    ["a length sent as a string", { durationMinutes: "30" }],
    ["an empty category id", { categoryId: "" }],
    ["an unknown publication status", { contentStatus: "ARCHIVED" }],
  ];
  for (const [name, body] of bad) {
    const parsed = sessionUpdateSchema.safeParse({ sessionId: SESSION_ID, ...body });
    assert.equal(parsed.success, false, name);
  }
  // A blank session id is not addressable either.
  assert.equal(sessionUpdateSchema.safeParse({ sessionId: "", title: "A talk" }).success, false);
});

/* -------------------------------------------------------------------------- */
/* The cross-event refusal                                                     */
/* -------------------------------------------------------------------------- */

test("a category from another event is the same 404 as one that does not exist", () => {
  /** Everything a caller could observe about the refusal, and nothing else. */
  function refusal(row: { id: string; eventId: string } | null) {
    try {
      requireEventOwnedRow(row, "event_1", "CATEGORY_NOT_FOUND", "Category");
      return null;
    } catch (error) {
      assert.ok(error instanceof ApiError);
      return {
        status: error.status,
        code: error.code,
        message: error.message,
        fieldErrors: error.fieldErrors,
      };
    }
  }

  // Another event's real category, and a category that never existed.
  const crossEvent = refusal({ id: "cat_1", eventId: "event_other" });
  const missing = refusal(null);
  assert.deepEqual(crossEvent, {
    status: 404,
    code: "CATEGORY_NOT_FOUND",
    message: "Category not found.",
    fieldErrors: undefined,
  });
  // Indistinguishable, field for field: an id cannot be used to tell another
  // event's topics from ones that were never there.
  assert.deepEqual(crossEvent, missing);

  // This event's own category is authorized and handed back.
  assert.deepEqual(
    requireEventOwnedRow({ id: "cat_1", eventId: "event_1" }, "event_1", "CATEGORY_NOT_FOUND", "Category"),
    { id: "cat_1", eventId: "event_1" },
  );
});

test("the route runs that check inside the write transaction, on named ids only", () => {
  const file = source("app/api/agenda/sessions/route.ts");
  const route = file.slice(file.indexOf("export const PATCH"));
  assert.match(route, /parseBody\(req, sessionUpdateSchema\)/);
  // A named id is checked; `null` clears the label and has no owner to check.
  assert.match(route, /if \(input\.categoryId !== undefined && input\.categoryId !== null\) \{/);
  assert.match(route, /tx\.category\.findUnique\(\{\r?\n?\s*where: \{ id: input\.categoryId \}/);
  assert.ok(route.indexOf("prisma.$transaction") < route.indexOf("tx.category.findUnique"));
});

/* -------------------------------------------------------------------------- */
/* INV-SCHEDULE-001                                                            */
/* -------------------------------------------------------------------------- */

test("a duration edit cannot move a slot, because nothing derives a slot from it", () => {
  // The decision recorded in the route: `ScheduleSlot` stores its own interval,
  // so editing `Session.durationMinutes` leaves the event's overlap predicate
  // untouched and needs no conflict re-check. This test is what makes that claim
  // falsifiable — if conflict detection ever starts reading a session's length,
  // or this route starts writing a slot, it fails.
  for (const path of ["lib/services/schedule.ts", "lib/agenda-conflicts.ts"]) {
    assert.doesNotMatch(source(path), /durationMinutes/, `${path} must not read a session's length`);
  }
  const route = source("app/api/agenda/sessions/route.ts");
  const patch = route.slice(route.indexOf("export const PATCH"));
  assert.doesNotMatch(patch, /scheduleSlot|startsAt|endsAt|lockScheduleWrite/);
});
