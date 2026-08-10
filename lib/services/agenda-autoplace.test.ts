import assert from "node:assert/strict";
import test from "node:test";
import {
  eligibleForPlacement,
  placementDayKeys,
  placementSnapshotFingerprint,
  planOpenSlotPlacements,
  PLACEMENT_MAX_DAYS,
  PLACEMENT_STEP_MINUTES,
  PLACEMENT_WINDOW_END_MINUTE,
  PLACEMENT_WINDOW_START_MINUTE,
  type PlacementSnapshot,
  type PlannerSession,
  type PlannerSlot,
} from "@/lib/services/agenda-autoplace";

const TZ = "UTC";
const DAY = "2026-05-12";
/** Epoch ms for an event-local (UTC, in these fixtures) hour on the fixture day. */
const at = (hour: number, minute = 0) => Date.UTC(2026, 4, 12, hour, minute);

function session(id: string, overrides: Partial<PlannerSession> = {}): PlannerSession {
  return { id, title: `Talk ${id}`, durationMinutes: 45, speakerIds: [], ...overrides };
}

function snapshot(overrides: Partial<PlacementSnapshot> = {}): PlacementSnapshot {
  return {
    eventId: "event-1",
    timezone: TZ,
    rooms: [
      { id: "room-b", sortOrder: 1 },
      { id: "room-a", sortOrder: 0 },
    ],
    existingSlots: [],
    unscheduled: [],
    eventDayKeys: [DAY],
    ...overrides,
  };
}

test("the window and step are the builder's grid on a quarter-hour lattice", () => {
  assert.equal(PLACEMENT_WINDOW_START_MINUTE, 8 * 60);
  assert.equal(PLACEMENT_WINDOW_END_MINUTE, 19 * 60);
  // Multiple of the 5-minute drag-and-drop snap, so a proposal is always a
  // position an operator could also have dragged a block to.
  assert.equal(PLACEMENT_STEP_MINUTES % 5, 0);
});

test("the same snapshot produces byte-identical output every time", () => {
  const input = snapshot({
    unscheduled: [session("s3"), session("s1", { speakerIds: ["u1"] }), session("s2", { speakerIds: ["u1"] })],
  });
  const first = planOpenSlotPlacements(input);
  const second = planOpenSlotPlacements(structuredClone(input));
  assert.deepEqual(second, first);

  // ...and the input order of rooms and sessions cannot change it.
  const shuffled = planOpenSlotPlacements(snapshot({
    rooms: [{ id: "room-a", sortOrder: 0 }, { id: "room-b", sortOrder: 1 }],
    unscheduled: [session("s2", { speakerIds: ["u1"] }), session("s3"), session("s1", { speakerIds: ["u1"] })],
  }));
  assert.deepEqual(shuffled, first);
});

test("openings are filled day, then start time, then room order, then session ID", () => {
  const plan = planOpenSlotPlacements(snapshot({
    unscheduled: [session("s2"), session("s1"), session("s3")],
  }));
  assert.deepEqual(
    plan.placements.map((p) => [p.sessionId, p.roomId, p.startMinute]),
    [
      // Earliest opening goes to the lowest room sortOrder and the lowest ID.
      ["s1", "room-a", 8 * 60],
      ["s2", "room-b", 8 * 60],
      // First lattice mark at or after a 45-minute talk ends: 08:45.
      ["s3", "room-a", 8 * 60 + 45],
    ],
  );
  assert.deepEqual(plan.unplaceable, []);
  assert.deepEqual(plan.days, [DAY]);
});

test("existing placements are left exactly where they are and never re-emitted", () => {
  const existing: PlannerSlot[] = [
    { slotId: "slot-1", sessionId: "kept", roomId: "room-a", startsAt: at(8), endsAt: at(9), speakerIds: ["u9"] },
  ];
  const plan = planOpenSlotPlacements(snapshot({
    existingSlots: existing,
    unscheduled: [session("s1")],
  }));
  assert.deepEqual(existing, [
    { slotId: "slot-1", sessionId: "kept", roomId: "room-a", startsAt: at(8), endsAt: at(9), speakerIds: ["u9"] },
  ]);
  assert.equal(plan.placements.some((p) => p.sessionId === "kept"), false);
  // room-a is busy at 08:00, so the first opening left is room-b at 08:00.
  assert.deepEqual(plan.placements.map((p) => [p.sessionId, p.roomId, p.startMinute]), [["s1", "room-b", 480]]);
});

test("a proposal never double-books a room, against existing or proposed slots", () => {
  const plan = planOpenSlotPlacements(snapshot({
    rooms: [{ id: "room-a", sortOrder: 0 }],
    existingSlots: [
      { slotId: "slot-1", sessionId: "kept", roomId: "room-a", startsAt: at(8), endsAt: at(9, 30), speakerIds: [] },
    ],
    unscheduled: [session("s1", { durationMinutes: 60 }), session("s2", { durationMinutes: 60 })],
  }));
  assert.deepEqual(
    plan.placements.map((p) => [p.sessionId, p.startsAt, p.endsAt]),
    [
      ["s1", new Date(at(9, 30)).toISOString(), new Date(at(10, 30)).toISOString()],
      ["s2", new Date(at(10, 30)).toISOString(), new Date(at(11, 30)).toISOString()],
    ],
  );
});

test("a shared speaker is never double-booked across rooms", () => {
  const plan = planOpenSlotPlacements(snapshot({
    unscheduled: [
      session("s1", { durationMinutes: 60, speakerIds: ["u1"] }),
      session("s2", { durationMinutes: 60, speakerIds: ["u1", "u2"] }),
    ],
  }));
  // Both would fit at 08:00 in different rooms, but they share `u1`.
  assert.deepEqual(
    plan.placements.map((p) => [p.sessionId, p.roomId, p.startMinute]),
    [["s1", "room-a", 480], ["s2", "room-a", 540]],
  );
});

test("a speaker already booked by an existing slot blocks that overlap", () => {
  const plan = planOpenSlotPlacements(snapshot({
    existingSlots: [
      { slotId: "slot-1", sessionId: "kept", roomId: "room-z", startsAt: at(8), endsAt: at(10), speakerIds: ["u1"] },
    ],
    unscheduled: [session("s1", { durationMinutes: 60, speakerIds: ["u1"] })],
  }));
  assert.deepEqual(plan.placements.map((p) => p.startMinute), [10 * 60]);
});

test("a talk with nowhere to go is reported, never silently dropped", () => {
  const plan = planOpenSlotPlacements(snapshot({
    rooms: [{ id: "room-a", sortOrder: 0 }],
    existingSlots: [
      // The only room is booked solid across the whole programme window.
      { slotId: "slot-1", sessionId: "kept", roomId: "room-a", startsAt: at(8), endsAt: at(19), speakerIds: [] },
    ],
    unscheduled: [session("s1", { durationMinutes: 60 })],
  }));
  assert.deepEqual(plan.placements, []);
  assert.equal(plan.unplaceable.length, 1);
  assert.equal(plan.unplaceable[0].sessionId, "s1");
  assert.equal(plan.unplaceable[0].reason, "NO_FREE_SLOT");
  assert.match(plan.unplaceable[0].message, /No room is free/);
});

test("a talk longer than the gap left in the day rolls over rather than overlapping", () => {
  const plan = planOpenSlotPlacements(snapshot({
    rooms: [{ id: "room-a", sortOrder: 0 }],
    eventDayKeys: [DAY, "2026-05-13"],
    existingSlots: [
      { slotId: "slot-1", sessionId: "kept", roomId: "room-a", startsAt: at(8), endsAt: at(15), speakerIds: [] },
    ],
    // Only four hours are left on day one; this needs eight.
    unscheduled: [session("s1", { durationMinutes: 480 })],
  }));
  assert.deepEqual(
    plan.placements.map((p) => [p.dayKey, p.startMinute]),
    [["2026-05-13", 480]],
  );
});

test("every eligible session appears exactly once, placed or explained", () => {
  const sessions = [
    session("s1", { durationMinutes: 60 }),
    session("s2", { durationMinutes: 60 }),
    session("s3", { durationMinutes: 60 }),
    session("s4", { durationMinutes: 0 }),
    session("s5", { durationMinutes: 600 }),
  ];
  const plan = planOpenSlotPlacements(snapshot({
    rooms: [{ id: "room-a", sortOrder: 0 }],
    unscheduled: sessions,
  }));
  const accounted = [
    ...plan.placements.map((p) => p.sessionId),
    ...plan.unplaceable.map((u) => u.sessionId),
  ].sort();
  assert.deepEqual(accounted, ["s1", "s2", "s3", "s4", "s5"]);
  assert.equal(plan.unplaceable.find((u) => u.sessionId === "s4")?.reason, "INVALID_DURATION");
  assert.equal(plan.unplaceable.find((u) => u.sessionId === "s5")?.reason, "INVALID_DURATION");
  assert.ok(plan.unplaceable.every((u) => u.message.length > 0 && u.title.length > 0));
});

test("no rooms and no days are reported as their own reasons", () => {
  const noRooms = planOpenSlotPlacements(snapshot({ rooms: [], unscheduled: [session("s1")] }));
  assert.deepEqual(noRooms.placements, []);
  assert.equal(noRooms.unplaceable[0].reason, "NO_ROOMS");

  const noDays = planOpenSlotPlacements(snapshot({ eventDayKeys: [], unscheduled: [session("s1")] }));
  assert.deepEqual(noDays.placements, []);
  assert.equal(noDays.unplaceable[0].reason, "NO_EVENT_DAYS");
});

test("nothing unscheduled produces an empty plan rather than an invented one", () => {
  const plan = planOpenSlotPlacements(snapshot({ unscheduled: [] }));
  assert.deepEqual(plan.placements, []);
  assert.deepEqual(plan.unplaceable, []);
});

test("the search rolls onto later event days once the first fills", () => {
  const plan = planOpenSlotPlacements(snapshot({
    rooms: [{ id: "room-a", sortOrder: 0 }],
    eventDayKeys: [DAY, "2026-05-13"],
    unscheduled: Array.from({ length: 12 }, (_, i) => session(`s${String(i).padStart(2, "0")}`, { durationMinutes: 60 })),
  }));
  // 08:00–19:00 fits eleven 60-minute talks in one room; the twelfth rolls over.
  assert.equal(plan.placements.filter((p) => p.dayKey === DAY).length, 11);
  assert.deepEqual(
    plan.placements.filter((p) => p.dayKey === "2026-05-13").map((p) => [p.sessionId, p.startMinute]),
    [["s11", 480]],
  );
});

test("days come from existing placements as well as the event range", () => {
  const plan = planOpenSlotPlacements(snapshot({
    eventDayKeys: [],
    existingSlots: [
      { slotId: "slot-1", sessionId: "kept", roomId: "room-a", startsAt: at(8), endsAt: at(9), speakerIds: [] },
    ],
    unscheduled: [session("s1")],
  }));
  assert.deepEqual(plan.days, [DAY]);
  assert.equal(plan.placements.length, 1);
});

test("the search day list is capped", () => {
  const many = Array.from({ length: 40 }, (_, i) => `2026-05-${String(i + 1).padStart(2, "0")}`);
  const plan = planOpenSlotPlacements(snapshot({ eventDayKeys: many }));
  assert.equal(plan.days.length, PLACEMENT_MAX_DAYS);
});

test("a placement lands on the event's local clock, not the runtime's", () => {
  const plan = planOpenSlotPlacements(snapshot({
    timezone: "America/Los_Angeles",
    unscheduled: [session("s1", { durationMinutes: 60 })],
  }));
  // 08:00 PDT on 2026-05-12 is 15:00 UTC.
  assert.equal(plan.placements[0].startsAt, "2026-05-12T15:00:00.000Z");
  assert.equal(plan.placements[0].endsAt, "2026-05-12T16:00:00.000Z");
  assert.equal(plan.placements[0].dayKey, DAY);
});

test("eligibility turns on duration, not publication state", () => {
  assert.equal(eligibleForPlacement(session("s1", { durationMinutes: 45 })), true);
  assert.equal(eligibleForPlacement(session("s1", { durationMinutes: 0 })), false);
  assert.equal(eligibleForPlacement(session("s1", { durationMinutes: -30 })), false);
  assert.equal(eligibleForPlacement(session("s1", { durationMinutes: 30.5 })), false);
  assert.equal(eligibleForPlacement(session("s1", { durationMinutes: Number.NaN })), false);
  assert.equal(eligibleForPlacement(session("s1", { durationMinutes: 481 })), false);
});

test("placementDayKeys walks the event's local calendar days inclusively", () => {
  assert.deepEqual(
    placementDayKeys("2026-05-12T00:00:00.000Z", "2026-05-14T00:00:00.000Z", "UTC"),
    ["2026-05-12", "2026-05-13", "2026-05-14"],
  );
  // Single-day event, and an inverted or missing end collapses to the start.
  assert.deepEqual(placementDayKeys("2026-05-12T09:00:00.000Z", null, "UTC"), ["2026-05-12"]);
  assert.deepEqual(
    placementDayKeys("2026-05-12T09:00:00.000Z", "2026-05-01T09:00:00.000Z", "UTC"),
    ["2026-05-12"],
  );
  assert.deepEqual(placementDayKeys(null, null, "UTC"), []);
  assert.deepEqual(placementDayKeys("not-a-date", null, "UTC"), []);
  // Crossing a DST spring-forward must not skip or repeat a day key.
  assert.deepEqual(
    placementDayKeys("2026-03-07T20:00:00.000Z", "2026-03-10T20:00:00.000Z", "America/Los_Angeles"),
    ["2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"],
  );
  assert.equal(placementDayKeys("2026-05-01T00:00:00.000Z", "2027-05-01T00:00:00.000Z", "UTC").length, PLACEMENT_MAX_DAYS);
});

test("the fingerprint is stable across input order and changes with the schedule", () => {
  const base = snapshot({
    existingSlots: [
      { slotId: "slot-1", sessionId: "kept", roomId: "room-a", startsAt: at(8), endsAt: at(9), speakerIds: ["u2", "u1"] },
    ],
    unscheduled: [session("s2"), session("s1")],
  });
  const reordered = snapshot({
    rooms: [{ id: "room-a", sortOrder: 0 }, { id: "room-b", sortOrder: 1 }],
    existingSlots: [
      { slotId: "slot-1", sessionId: "kept", roomId: "room-a", startsAt: at(8), endsAt: at(9), speakerIds: ["u1", "u2"] },
    ],
    unscheduled: [session("s1"), session("s2")],
  });
  assert.equal(placementSnapshotFingerprint(reordered), placementSnapshotFingerprint(base));

  const moved = snapshot({
    existingSlots: [
      { slotId: "slot-1", sessionId: "kept", roomId: "room-b", startsAt: at(8), endsAt: at(9), speakerIds: ["u1", "u2"] },
    ],
    unscheduled: [session("s1"), session("s2")],
  });
  assert.notEqual(placementSnapshotFingerprint(moved), placementSnapshotFingerprint(base));

  const oneFewer = snapshot({
    existingSlots: base.existingSlots,
    unscheduled: [session("s1")],
  });
  assert.notEqual(placementSnapshotFingerprint(oneFewer), placementSnapshotFingerprint(base));
});
