import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import { ApiError, toResponse } from "@/lib/api/http";
import { detectConflicts, type SlotInterval } from "@/lib/services/schedule";
import { scheduleWriteLockKeys } from "@/lib/services/schedule-lock";
import {
  resolveCandidateSlotId,
  SLOT_IDENTITY_MISMATCH_CODE,
  SLOT_IDENTITY_MISMATCH_MESSAGE,
  SLOT_NOT_FOUND_CODE,
  SLOT_NOT_FOUND_MESSAGE,
  unscheduleSessionSlot,
  type ScheduleSlotDeleteDependencies,
} from "@/lib/services/schedule-slot-write";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const ROUTE = "app/api/agenda/slots/route.ts";
const tx = {} as Prisma.TransactionClient;

/** `assert.throws` returns undefined, so capture the error to assert on it. */
function caught(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ApiError, "expected an ApiError");
    return error;
  }
  throw new assert.AssertionError({ message: "expected a refusal, got a return" });
}

/* -------------------------------------------------------------------------- */
/* GRA-01 — a forged slot id cannot excuse a conflict                          */
/* -------------------------------------------------------------------------- */

test("an omitted id keeps the server's own answer, scheduled or not", () => {
  // The only shape the shipped client ever sends. Behaviour is unchanged: a
  // move still excludes the slot the session already occupies...
  assert.equal(resolveCandidateSlotId(undefined, "slot-own"), "slot-own");
  // ...and a first placement still has no slot to exclude.
  assert.equal(resolveCandidateSlotId(undefined, undefined), undefined);
});

test("a request naming the session's own slot is accepted and adds nothing", () => {
  assert.equal(resolveCandidateSlotId("slot-own", "slot-own"), "slot-own");
});

test("a forged foreign slot id is refused 422, not silently honoured", () => {
  const thrown = caught(() => resolveCandidateSlotId("slot-someone-else", "slot-own"));
  assert.equal(thrown.status, 422);
  assert.equal(thrown.code, SLOT_IDENTITY_MISMATCH_CODE);
  assert.deepEqual(thrown.fieldErrors, { id: [SLOT_IDENTITY_MISMATCH_MESSAGE] });
});

test("an id sent for a session that holds no slot is refused too", () => {
  // There is no true id to send here, so every id is forged. Falling through to
  // `undefined` would have been the same bypass with an extra step.
  const thrown = caught(() => resolveCandidateSlotId("slot-someone-else", undefined));
  assert.equal(thrown.status, 422);
  assert.equal(thrown.code, SLOT_IDENTITY_MISMATCH_CODE);
});

test("the refusal serialises as a 422 in the shared failure envelope", async () => {
  const response = toResponse(caught(() => resolveCandidateSlotId("slot-forged", "slot-own")));
  // 422, never 400 — the repo's refusal convention for a well-formed body that
  // is semantically inadmissible.
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: {
      code: SLOT_IDENTITY_MISMATCH_CODE,
      message: SLOT_IDENTITY_MISMATCH_MESSAGE,
      fieldErrors: { id: [SLOT_IDENTITY_MISMATCH_MESSAGE] },
    },
  });
});

/**
 * The refusal only matters because the id it refuses really did suppress a
 * conflict. This reproduces the bypass against the real detector rather than
 * asserting it from the description.
 */
test("the forged id would otherwise have hidden a real room conflict", () => {
  const existing: SlotInterval[] = [{
    slotId: "slot-victim",
    roomId: "room-a",
    startsAt: Date.parse("2026-05-12T16:00:00.000Z"),
    endsAt: Date.parse("2026-05-12T17:00:00.000Z"),
    speakerIds: ["user-x"],
  }];
  const candidate = {
    roomId: "room-a",
    startsAt: Date.parse("2026-05-12T16:30:00.000Z"),
    endsAt: Date.parse("2026-05-12T17:30:00.000Z"),
    speakerIds: ["user-x"],
  };

  // What the old `input.id ?? ownSlot?.id` produced for a caller who sent the
  // victim's id: the collision disappears and the route answers "no conflicts".
  assert.deepEqual(detectConflicts({ slotId: "slot-victim", ...candidate }, existing), []);
  // What the route computes now — the caller never reaches this, because
  // `resolveCandidateSlotId` throws first, but the truth it was suppressing is
  // exactly this.
  const honest = detectConflicts({ slotId: undefined, ...candidate }, existing);
  assert.deepEqual(honest.map((c) => c.type), ["ROOM_OVERLAP", "SPEAKER_OVERLAP"]);
});

test("the route resolves the identity before any write, and no longer trusts input.id", () => {
  const route = source(ROUTE);
  const post = route.slice(route.indexOf("export const POST"), route.indexOf("export const DELETE"));

  // The bypass itself is gone.
  assert.doesNotMatch(post, /input\.id \?\? ownSlot\?\.id/);
  assert.match(post, /slotId: resolveCandidateSlotId\(input\.id, ownSlot\?\.id\)/);

  // It runs before the upsert, so a refusal throws out of the transaction and
  // nothing is written. (`handle` turns the ApiError into the 422 response.)
  const resolvedAt = post.indexOf("resolveCandidateSlotId(");
  assert.ok(resolvedAt > 0);
  assert.ok(resolvedAt < post.indexOf("tx.scheduleSlot.upsert("));
  assert.ok(post.indexOf("prisma.$transaction(") < resolvedAt);
});

test("the conflict-declaration path is untouched by the identity refusal", () => {
  // PR #73's deliberate "Schedule anyway" override stays exactly as it was:
  // this fix decides whose conflicts are counted, never whether a declared
  // conflict may be recorded.
  const route = source(ROUTE);
  assert.match(route, /const force = new URL\(req\.url\)\.searchParams\.get\("force"\) === "true"/);
  assert.match(route, /if \(conflicts\.length > 0 && !force\)/);
  assert.match(route, /return fail\(409, "SCHEDULE_CONFLICT"/);
});

/* -------------------------------------------------------------------------- */
/* GRA-02 — unschedule under the S3 event lock                                 */
/* -------------------------------------------------------------------------- */

type Recorder = { calls: string[]; dependencies: ScheduleSlotDeleteDependencies };

function recorder(slot: { id: string } | null): Recorder {
  const calls: string[] = [];
  return {
    calls,
    dependencies: {
      async lockScheduleWrite(_tx, eventId, dayKeys = []) {
        calls.push(`lock:${scheduleWriteLockKeys(eventId, dayKeys).join(",")}`);
      },
      async findOwnedSlot(_tx, { eventId, sessionId }) {
        calls.push(`read:${eventId}:${sessionId}`);
        return slot;
      },
      async deleteSlot(_tx, sessionId) {
        calls.push(`delete:${sessionId}`);
      },
    },
  };
}

test("unschedule takes the event lock first, then re-reads, then deletes", async () => {
  const { calls, dependencies } = recorder({ id: "slot-1" });

  const result = await unscheduleSessionSlot(
    tx,
    { eventId: "event-1", sessionId: "session-1" },
    dependencies,
  );

  // Order is the whole fix: the ownership read must happen under the lock, not
  // before it, or the row can move between the check and the delete.
  assert.deepEqual(calls, [
    "lock:schedule-write:event-1",
    "read:event-1:session-1",
    "delete:session-1",
  ]);
  // Success shape unchanged.
  assert.deepEqual(result, { sessionId: "session-1", unscheduled: true });
});

test("a missing slot is the same 404 as before, taken under the lock and writing nothing", async () => {
  const { calls, dependencies } = recorder(null);

  await assert.rejects(
    () => unscheduleSessionSlot(tx, { eventId: "event-1", sessionId: "session-1" }, dependencies),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 404);
      assert.equal(error.code, SLOT_NOT_FOUND_CODE);
      assert.equal(error.message, SLOT_NOT_FOUND_MESSAGE);
      return true;
    },
  );
  // The lock is still taken first, and no delete is attempted.
  assert.ok(calls.every((call) => !call.startsWith("delete:")));
  assert.deepEqual(calls, ["lock:schedule-write:event-1", "read:event-1:session-1"]);
});

test("the 404 serialises to the shape the client already handles", async () => {
  const response = toResponse(new ApiError(404, SLOT_NOT_FOUND_CODE, SLOT_NOT_FOUND_MESSAGE));
  assert.equal(response.status, 404);
  // Byte-identical to the pre-fix refusal: same status, same code, same words.
  assert.deepEqual(await response.json(), {
    ok: false,
    error: { code: "SLOT_NOT_FOUND", message: "No schedule slot for this session." },
  });
});

test("the cross-event slot is refused by the production ownership predicate", () => {
  // The predicate itself lives in the route module's production dependencies,
  // so it is pinned at source: unknown and foreign must stay indistinguishable.
  const service = source("lib/services/schedule-slot-write.ts");
  assert.match(service, /slot && slot\.session\.eventId === eventId \? \{ id: slot\.id \} : null/);
  assert.match(service, /where: \{ sessionId \}/);
});

/**
 * "delete vs move" and "delete vs auto-placement" are decided by the lock, so
 * the provable claim is that all three writers serialise on the same key and
 * take it in the same position. Asserted over the three sources, not described.
 */
test("delete, manual move, and auto-placement all serialise on the same first key", () => {
  // Same key. The delete takes no day keys, so its sequence is exactly the
  // prefix of the auto-placer's.
  assert.deepEqual(scheduleWriteLockKeys("event-1", []), ["schedule-write:event-1"]);
  assert.equal(
    scheduleWriteLockKeys("event-1", ["2026-05-12", "2026-05-13"])[0],
    scheduleWriteLockKeys("event-1", [])[0],
  );

  const route = source(ROUTE);
  const post = route.slice(route.indexOf("export const POST"), route.indexOf("export const DELETE"));
  const apply = source("app/api/agenda/autoplace/apply/route.ts");
  // The delete's lock lives in the service the DELETE handler delegates to.
  const service = source("lib/services/schedule-slot-write.ts");
  const unschedule = service.slice(service.indexOf("export async function unscheduleSessionSlot"));

  // Each writer takes the event-wide key, and each is inside a transaction —
  // an advisory *xact* lock outside one would be released immediately.
  for (const [name, writer, lockCall] of [
    ["delete", unschedule, "dependencies.lockScheduleWrite(tx, input.eventId)"],
    ["move", post, "lockScheduleWrite(tx, ctx.eventId)"],
    ["autoplace", apply, "lockScheduleWrite(tx, ctx.eventId, proposedDayKeys)"],
  ] as const) {
    assert.ok(writer.includes(lockCall), `${name} must take the event-wide schedule key`);
  }
  assert.match(route.slice(route.indexOf("export const DELETE")), /prisma\.\$transaction\(/);
  assert.match(post, /prisma\.\$transaction\(/);
  assert.match(apply, /prisma\.\$transaction\(/);

  // In the delete path the key is taken before the read and before the write —
  // the same position the other two take it in.
  assert.ok(
    unschedule.indexOf("dependencies.lockScheduleWrite(") < unschedule.indexOf("dependencies.findOwnedSlot("),
  );
  assert.ok(
    unschedule.indexOf("dependencies.findOwnedSlot(") < unschedule.indexOf("dependencies.deleteSlot("),
  );
  assert.ok(post.indexOf("lockScheduleWrite(") < post.indexOf("tx.scheduleSlot.findMany"));
  assert.ok(apply.indexOf("lockScheduleWrite(") < apply.indexOf("lockEventScheduleSlotsForUpdate("));
});

test("the DELETE handler holds no unlocked read or write of its own", () => {
  const route = source(ROUTE);
  const del = route.slice(route.indexOf("export const DELETE"));

  // One transaction, and the slot work happens inside it.
  assert.match(del, /await prisma\.\$transaction\(\(tx\) =>[\s\S]*?unscheduleSessionSlot\(tx, \{ eventId: ctx\.eventId, sessionId \}\)/);
  // Nothing touches the base client directly any more — that was the bug.
  assert.doesNotMatch(del, /prisma\.scheduleSlot\./);
  // Same guard, same admin gate, same success payload.
  assert.match(del, /requireContext\(\["ADMIN"\]\)/);
  assert.match(del, /throw new ApiError\(400, "MISSING_SESSION"/);
  assert.match(del, /return ok\(result\)/);
});
