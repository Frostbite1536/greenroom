import assert from "node:assert/strict";
import { test } from "node:test";
import { detectConflicts, intervalsOverlap, type SlotInterval } from "@/lib/services/schedule";

const t = (h: number, m = 0) => Date.UTC(2026, 2, 1, h, m);

const existing: SlotInterval[] = [
  { slotId: "s1", roomId: "roomA", startsAt: t(9), endsAt: t(10), speakerIds: ["u1"] },
  { slotId: "s2", roomId: "roomB", startsAt: t(9, 30), endsAt: t(10, 30), speakerIds: ["u2"] },
];

test("intervalsOverlap treats bounds as half-open", () => {
  assert.equal(intervalsOverlap(t(9), t(10), t(10), t(11)), false);
  assert.equal(intervalsOverlap(t(9), t(10), t(9, 30), t(11)), true);
});

test("no conflict when room and speakers differ", () => {
  const conflicts = detectConflicts(
    { roomId: "roomC", startsAt: t(9), endsAt: t(10), speakerIds: ["u3"] },
    existing,
  );
  assert.equal(conflicts.length, 0);
});

test("room overlap is detected", () => {
  const conflicts = detectConflicts(
    { roomId: "roomA", startsAt: t(9, 30), endsAt: t(10, 30), speakerIds: ["u9"] },
    existing,
  );
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].type, "ROOM_OVERLAP");
  assert.equal(conflicts[0].conflictingSlotId, "s1");
});

test("speaker overlap is detected across rooms", () => {
  const conflicts = detectConflicts(
    { roomId: "roomC", startsAt: t(9, 15), endsAt: t(9, 45), speakerIds: ["u1"] },
    existing,
  );
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].type, "SPEAKER_OVERLAP");
});

test("adjacent slots do not conflict", () => {
  const conflicts = detectConflicts(
    { roomId: "roomA", startsAt: t(10), endsAt: t(11), speakerIds: ["u1"] },
    existing,
  );
  assert.equal(conflicts.length, 0);
});

test("editing a slot ignores itself", () => {
  const conflicts = detectConflicts(
    { slotId: "s1", roomId: "roomA", startsAt: t(9), endsAt: t(10), speakerIds: ["u1"] },
    existing,
  );
  assert.equal(conflicts.length, 0);
});
