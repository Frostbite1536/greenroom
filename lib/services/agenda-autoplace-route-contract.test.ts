import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  openSlotApplyInputSchema,
  openSlotPreviewInputSchema,
  OPEN_SLOT_PLAN_MAX_PLACEMENTS,
  OPEN_SLOT_STALE_CODE,
  STALE_PREVIEW_MESSAGE,
} from "@/lib/services/agenda-autoplace-request";
import { scheduleDayKeyForInstant, scheduleWriteLockKeys } from "@/lib/services/schedule-lock";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/**
 * The same file with comments stripped. "This route never touches X" has to be
 * asserted against code, not against a doc comment that says the words.
 */
const code = (path: string) =>
  source(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

const PREVIEW = "app/api/agenda/autoplace/preview/route.ts";
const APPLY = "app/api/agenda/autoplace/apply/route.ts";
const LOCK = "lib/services/schedule-lock.ts";

test("the stale refusal is the addendum's exact wording", () => {
  assert.equal(
    STALE_PREVIEW_MESSAGE,
    "The agenda changed after this preview was created. Generate a new preview before applying it.",
  );
});

test("preview is admin-only, event-scoped, and writes nothing", () => {
  const preview = source(PREVIEW);
  assert.match(preview, /requireContext\(\["ADMIN"\]\)/);
  assert.match(preview, /assertEventScope\(ctx, input\.eventId\)/);
  // A read that changes nothing: no mutation of any kind, and no comms.
  const previewCode = code(PREVIEW);
  for (const mutation of [
    /\.create\(/, /\.createMany\(/, /\.update\(/, /\.updateMany\(/,
    /\.upsert\(/, /\.delete\(/, /\.deleteMany\(/, /\$executeRaw/,
  ]) {
    assert.doesNotMatch(previewCode, mutation);
  }
  assert.doesNotMatch(previewCode, /comms|calendar|dispatch|revision/i);
  // Consistent snapshot, so the fingerprint describes one real moment.
  assert.match(preview, /isolationLevel: Prisma\.TransactionIsolationLevel\.RepeatableRead/);
  assert.match(preview, /fingerprint: placementSnapshotFingerprint\(snapshot\)/);
  // Partial programmes fail closed rather than planning against rows never read.
  assert.match(preview, /assertEventQueryBound\(sessions, OPERATOR_QUERY_LIMITS\.agendaSessions/);
});

test("apply takes the S3 locks in order before it reads or validates anything", () => {
  const apply = source(APPLY);
  assert.match(apply, /requireContext\(\["ADMIN"\]\)/);
  assert.match(apply, /assertEventScope\(ctx, input\.eventId\)/);
  assert.match(apply, /prisma\.\$transaction\(/);

  const order = [
    "lockScheduleWrite(tx, ctx.eventId, proposedDayKeys)",
    // The configuration parent, before the resources it scopes.
    "lockEventForShare(tx, ctx.eventId)",
    "lockScheduleRoomsForShare(",
    "lockScheduleSpeakersForShare(",
    "lockScheduleSessionsForShare(",
    "lockEventScheduleSlotsForUpdate(tx, ctx.eventId)",
  ];
  let previous = -1;
  for (const step of order) {
    const at = apply.indexOf(step);
    assert.ok(at > previous, `${step} must follow the previous lock step`);
    previous = at;
  }
  // Every fresh read and every decision happens after the last lock.
  assert.ok(previous < apply.indexOf("tx.session.findMany"));
  assert.ok(previous < apply.indexOf("placementSnapshotFingerprint(snapshot)"));
  assert.ok(previous < apply.indexOf("detectConflicts("));
});

test("event settings are read only under the lock, never before it", () => {
  const apply = source(APPLY);
  // Exactly one read of the event row, and it is the locked one.
  assert.doesNotMatch(code(APPLY), /tx\.event\.find/);
  assert.equal((code(APPLY).match(/lockEventForShare\(/g) ?? []).length, 1);

  // Everything that decides where a placement may land derives from that row.
  assert.match(apply, /const event = await lockEventForShare\(tx, ctx\.eventId\)/);
  assert.match(apply, /const timezone = event\.timezone/);
  assert.match(apply, /eventDayKeys: placementDayKeys\(event\.startsAt, event\.endsAt, timezone\)/);
  const lockedAt = apply.indexOf("lockEventForShare(tx, ctx.eventId)");
  for (const use of [
    "const timezone = event.timezone",
    "placementDayKeys(event.startsAt, event.endsAt, timezone)",
    "const searchableDays",
    "zonedParts(placement.startsAt, timezone)",
  ]) {
    assert.ok(apply.indexOf(use) > lockedAt, `${use} must read the locked event row`);
  }

  // The advisory day keys cannot depend on a timezone read before the lock.
  assert.match(apply, /scheduleDayKeyForInstant\(placement\.startsAt\)/);
  assert.ok(apply.indexOf("proposedDayKeys") < lockedAt);
});

test("the slot pre-read is bounded and covered by the advisory key", () => {
  const apply = source(APPLY);
  const keyAt = apply.indexOf("lockScheduleWrite(tx, ctx.eventId, proposedDayKeys)");
  const preReadAt = apply.indexOf("tx.scheduleSlot.findMany");
  // It reads slots only to build the speaker lock set, so it cannot be deleted
  // — but it must sit inside the advisory key, and it must be bounded.
  assert.ok(keyAt < preReadAt, "the slot read must follow the event-wide advisory key");
  assert.ok(preReadAt < apply.indexOf("lockScheduleSpeakersForShare("));
  assert.match(apply, /take: OPERATOR_QUERY_LIMITS\.agendaSessions \+ 1/);
  assert.match(
    apply,
    /assertEventQueryBound\(slotSessionRows, OPERATOR_QUERY_LIMITS\.agendaSessions, "scheduled sessions"\)/,
  );
  // The defence-in-depth guard against a writer that skips the key is kept.
  assert.match(apply, /refuse\("SCHEDULE_CHANGED"\)/);
});

test("apply revalidates every target against the locked rows, not the request", () => {
  const apply = source(APPLY);
  for (const check of [
    // Ownership: unknown and cross-event are the same refusal.
    /if \(!session \|\| session\.eventId !== ctx\.eventId\) refuse\("SESSION_NOT_FOUND"\)/,
    // Still unscheduled, room still exists in this event.
    /if \(scheduledSessionIds\.has\(placement\.sessionId\)\) refuse\("ALREADY_SCHEDULED"\)/,
    /if \(!roomIds\.has\(placement\.roomId\)\) refuse\("ROOM_NOT_FOUND"\)/,
    // The stored talk length, not the client's arithmetic.
    /durationMinutes !== session!\.durationMinutes\) refuse\("DURATION_CHANGED"\)/,
    // In-window, on the lattice, on a real event day.
    /if \(!searchableDays\.has\(local\.dateKey\)\) refuse\("OUT_OF_WINDOW"\)/,
    /PLACEMENT_WINDOW_START_MINUTE\) refuse\("OUT_OF_WINDOW"\)/,
    /PLACEMENT_STEP_MINUTES !== 0\) refuse\("OUT_OF_WINDOW"\)/,
    /PLACEMENT_WINDOW_END_MINUTE\) refuse\("OUT_OF_WINDOW"\)/,
    // Conflicts against existing slots and every proposal accepted so far.
    /if \(detectConflicts\(candidate, intervals\)\.length > 0\) refuse\("CONFLICT"\)/,
    /intervals\.push\(\{ slotId: `applying:\$\{placement\.sessionId\}`, \.\.\.candidate \}\)/,
  ]) {
    assert.match(apply, check);
  }
  // Speaker sets come from the locked SessionSpeaker rows, never from the body.
  assert.match(apply, /speakerIds: speakersOf\(placement\.sessionId\)/);
  assert.match(apply, /speakerIds: speakersOf\(slot\.sessionId\)/);
});

test("the fingerprint is an early exit, not the authority", () => {
  const apply = source(APPLY);
  const fingerprintAt = apply.indexOf("placementSnapshotFingerprint(snapshot) !== input.fingerprint");
  assert.ok(fingerprintAt > 0);
  // Every state-derived refusal still exists after it, so deleting the
  // fingerprint check could not let an invalid placement through.
  for (const later of ["SESSION_NOT_FOUND", "ROOM_NOT_FOUND", "OUT_OF_WINDOW", "CONFLICT"]) {
    assert.ok(apply.indexOf(later) > fingerprintAt, `${later} must be checked after the fingerprint`);
  }
});

test("apply writes the whole plan in one statement and nothing else", () => {
  const apply = source(APPLY);
  assert.match(apply, /await tx\.scheduleSlot\.createMany\(\{ data: rows \}\)/);
  // No per-placement write loop, and no side effect beyond the slots.
  const applyCode = code(APPLY);
  assert.doesNotMatch(applyCode, /scheduleSlot\.(create|upsert|update)\(/);
  assert.doesNotMatch(applyCode, /contentStatus/);
  assert.doesNotMatch(applyCode, /comms|calendar|dispatch|email/i);
  // Every refusal throws, so the transaction rolls back before any write.
  assert.match(apply, /const refuse = \(reason: string\): never => \{\s*throw new ApiError\(409, OPEN_SLOT_STALE_CODE, STALE_PREVIEW_MESSAGE/);
  assert.ok(apply.lastIndexOf("refuse(\"CONFLICT\")") < apply.indexOf("createMany"));
});

test("every refusal returns the one stale message under one code", () => {
  assert.equal(OPEN_SLOT_STALE_CODE, "STALE_PREVIEW");
  const apply = source(APPLY);
  // Exactly one ApiError construction carries a placement-level refusal.
  const refusals = apply.match(/new ApiError\(409[^)]*/g) ?? [];
  assert.equal(refusals.length, 1);
});

test("duplicate session proposals are refused before any lock is taken", () => {
  const placement = {
    sessionId: "s1",
    roomId: "room-a",
    startsAt: "2026-05-12T08:00:00.000Z",
    endsAt: "2026-05-12T09:00:00.000Z",
  };
  const duplicated = openSlotApplyInputSchema.safeParse({
    eventId: "event-1",
    fingerprint: "abc",
    placements: [placement, { ...placement, roomId: "room-b" }],
  });
  assert.equal(duplicated.success, false);
  assert.match(JSON.stringify(duplicated.error?.issues), /same session more than once/);

  const distinct = openSlotApplyInputSchema.safeParse({
    eventId: "event-1",
    fingerprint: "abc",
    placements: [placement, { ...placement, sessionId: "s2" }],
  });
  assert.equal(distinct.success, true);
});

test("malformed and unbounded plans are refused at the boundary", () => {
  const base = {
    eventId: "event-1",
    fingerprint: "abc",
    placements: [{
      sessionId: "s1",
      roomId: "room-a",
      startsAt: "2026-05-12T08:00:00.000Z",
      endsAt: "2026-05-12T09:00:00.000Z",
    }],
  };
  assert.equal(openSlotApplyInputSchema.safeParse({ ...base, placements: [] }).success, false);
  assert.equal(openSlotApplyInputSchema.safeParse({ ...base, fingerprint: "" }).success, false);
  assert.equal(openSlotApplyInputSchema.safeParse({ ...base, eventId: "" }).success, false);
  // Inverted interval.
  assert.equal(
    openSlotApplyInputSchema.safeParse({
      ...base,
      placements: [{ ...base.placements[0], endsAt: "2026-05-12T07:00:00.000Z" }],
    }).success,
    false,
  );
  // Not a datetime at all.
  assert.equal(
    openSlotApplyInputSchema.safeParse({
      ...base,
      placements: [{ ...base.placements[0], startsAt: "2026-05-12" }],
    }).success,
    false,
  );
  const oversize = Array.from({ length: OPEN_SLOT_PLAN_MAX_PLACEMENTS + 1 }, (_, i) => ({
    ...base.placements[0],
    sessionId: `s${i}`,
  }));
  assert.equal(openSlotApplyInputSchema.safeParse({ ...base, placements: oversize }).success, false);

  assert.equal(openSlotPreviewInputSchema.safeParse({ eventId: "event-1" }).success, true);
  assert.equal(openSlotPreviewInputSchema.safeParse({}).success, false);
});

test("the schedule lock keys are ordinal, deduplicated, and event-wide first", () => {
  assert.deepEqual(
    scheduleWriteLockKeys("event-1", ["2026-05-13", "2026-05-12", "2026-05-13"]),
    [
      "schedule-write:event-1",
      "schedule-day:event-1:2026-05-12",
      "schedule-day:event-1:2026-05-13",
    ],
  );
  assert.deepEqual(scheduleWriteLockKeys("event-1", []), ["schedule-write:event-1"]);
});

test("the advisory day key is timezone-independent", () => {
  // The same instant, expressed with an offset, yields the same partition key —
  // and the key never moves when an administrator edits the event timezone.
  assert.equal(scheduleDayKeyForInstant("2026-05-12T23:30:00.000Z"), "2026-05-12");
  assert.equal(scheduleDayKeyForInstant("2026-05-12T16:30:00-07:00"), "2026-05-12");
  assert.equal(scheduleDayKeyForInstant(new Date("2026-05-13T00:30:00.000Z")), "2026-05-13");
});

test("the event row is locked FOR SHARE, which is what the settings PATCH conflicts with", () => {
  const lock = source(LOCK);
  assert.match(lock, /FROM "Event"\s*WHERE "id" = \$\{eventId\}\s*FOR SHARE/);
  // The settings writer takes the same row exclusively and takes nothing else,
  // so Event-first here cannot cycle with it.
  const settings = source("app/api/admin/settings/route.ts");
  assert.match(settings, /FROM "Event"\s*WHERE "id" = \$\{ctx\.eventId\}\s*FOR UPDATE/);
  assert.doesNotMatch(settings, /FOR SHARE/);
  // Event is the first row lock in the schedule sequence.
  assert.ok(lock.indexOf("lockEventForShare") < lock.indexOf("lockScheduleRoomsForShare"));
});

/**
 * The no-cycle argument for taking Event first rests on a claim about every
 * writer that locks the row, so it is asserted over all of them rather than
 * described. Event-before-its-children is an existing convention here; apply
 * joins it rather than inventing a position.
 */
test("every Event locker takes that row before the resources it scopes", () => {
  const speakers = source("app/api/admin/speakers/route.ts");
  const speakersPost = speakers.slice(speakers.indexOf("export const POST"));
  assert.match(speakersPost, /SELECT "id" FROM "Event" WHERE "id" = \$\{ctx\.eventId\} FOR SHARE/);
  assert.ok(
    speakersPost.indexOf('FROM "Event"') < speakersPost.indexOf("lockPublicSubmissionIdentities"),
    "the speaker writer locks Event before its identity locks",
  );

  const invites = source("app/api/evaluations/reviewer-invites/route.ts");
  const invitesPost = invites.slice(invites.indexOf("export const POST"));
  assert.match(invitesPost, /SELECT "id", "name", "slug" FROM "Event" WHERE "id" = \$\{ctx\.eventId\} FOR SHARE/);
  assert.ok(
    invitesPost.indexOf('FROM "Event"') < invitesPost.indexOf("lockPublicSubmissionIdentities"),
    "the reviewer-invite writer locks Event before its identity locks",
  );

  // The only exclusive taker holds Event alone, so it can never wait on a class
  // this path holds while this path waits on Event.
  const settings = source("app/api/admin/settings/route.ts");
  const settingsPatch = settings.slice(settings.indexOf("export const PATCH"));
  assert.equal((settingsPatch.match(/FOR UPDATE/g) ?? []).length, 1);
  assert.doesNotMatch(settingsPatch, /lock[A-Z]/);

  // ...and the room writers take Room alone, never Event.
  const rooms = source("app/api/admin/settings/rooms/route.ts");
  assert.doesNotMatch(rooms, /FROM "Event"/);
});

test("every schedule lock read is ordinally ordered and row-locked", () => {
  const lock = source(LOCK);
  assert.match(lock, /pg_advisory_xact_lock\(hashtextextended\(\$\{key\}, 0\)\)/);
  assert.match(lock, /FROM "Room"[\s\S]*?ORDER BY "id" COLLATE "C"\s*FOR SHARE/);
  assert.match(lock, /FROM "SessionSpeaker"[\s\S]*?ORDER BY "sessionId" COLLATE "C", "userId" COLLATE "C"\s*FOR SHARE/);
  assert.match(lock, /FROM "Session"[\s\S]*?ORDER BY "id" COLLATE "C"\s*FOR SHARE/);
  assert.match(lock, /FROM "ScheduleSlot"[\s\S]*?WHERE "eventId" = \$\{eventId\}[\s\S]*?ORDER BY "id" COLLATE "C"\s*FOR UPDATE/);
});

test("the manual placement route now shares the event-wide schedule key", () => {
  const slots = source("app/api/agenda/slots/route.ts");
  const post = slots.slice(slots.indexOf("export const POST"), slots.indexOf("export const DELETE"));
  assert.match(post, /await lockScheduleWrite\(tx, ctx\.eventId\)/);
  assert.ok(post.indexOf("lockScheduleWrite") < post.indexOf("tx.scheduleSlot.findMany"));
  assert.ok(post.indexOf("lockScheduleWrite") < post.indexOf("tx.scheduleSlot.upsert"));
  // Behaviour is otherwise untouched: same conflict authority, same force
  // override, same responses.
  assert.match(post, /detectConflicts\(/);
  assert.match(post, /if \(conflicts\.length > 0 && !force\)/);
  assert.match(post, /tx\.scheduleSlot\.upsert\(/);
});
