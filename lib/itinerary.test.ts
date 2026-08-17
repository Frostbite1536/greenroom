import assert from "node:assert/strict";
import test from "node:test";

import {
  ITINERARY_STORAGE_VERSION,
  MAX_ITINERARY_SESSIONS,
  itineraryOverlaps,
  itinerarySessions,
  itineraryStorageKey,
  itineraryTabLabel,
  overlapNotice,
  parseItinerarySessionIds,
  readItinerary,
  serializeItinerarySessionIds,
  toggleItineraryId,
  writeItinerary,
  type ItinerarySession,
} from "./itinerary";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

const session = (
  sessionId: string,
  startsAt: string,
  endsAt: string,
  title = sessionId,
): ItinerarySession => ({
  sessionId,
  title,
  startsAt,
  endsAt,
  roomName: "Hall A",
  trackName: null,
  trackColor: null,
});

test("the storage key is versioned and scoped to one event", () => {
  assert.equal(itineraryStorageKey("devcon-2026"), "greenroom.itinerary.v1:devcon-2026");
  assert.notEqual(itineraryStorageKey("a"), itineraryStorageKey("b"));
});

test("a reader's stored itinerary is re-validated, never trusted as written", () => {
  const key = itineraryStorageKey("evt");
  // Hand-edited storage: a wrong version, a non-array, junk ids and duplicates.
  assert.deepEqual(readItinerary(memoryStorage({ [key]: "not json" }), "evt"), []);
  assert.deepEqual(readItinerary(memoryStorage({ [key]: "[]" }), "evt"), []);
  assert.deepEqual(
    readItinerary(memoryStorage({ [key]: JSON.stringify({ version: 99, sessionIds: ["a"] }) }), "evt"),
    [],
  );
  assert.deepEqual(
    readItinerary(
      memoryStorage({
        [key]: JSON.stringify({
          version: ITINERARY_STORAGE_VERSION,
          sessionIds: ["ok1", "ok1", 7, "", "bad id", "x".repeat(65), "ok2"],
        }),
      }),
      "evt",
    ),
    ["ok1", "ok2"],
  );
});

test("a missing or throwing storage yields an empty itinerary rather than failing", () => {
  assert.deepEqual(readItinerary(null, "evt"), []);
  const throwing = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };
  assert.deepEqual(readItinerary(throwing, "evt"), []);
  assert.equal(writeItinerary(throwing, "evt", ["a"]), false);
  assert.equal(writeItinerary(null, "evt", ["a"]), false);
});

test("writing stores a versioned record under the event key, and emptying removes it", () => {
  const storage = memoryStorage();
  assert.equal(writeItinerary(storage, "evt", ["a", "a", "b"]), true);
  assert.deepEqual(JSON.parse(storage.map.get(itineraryStorageKey("evt"))!), {
    version: ITINERARY_STORAGE_VERSION,
    sessionIds: ["a", "b"],
  });
  assert.deepEqual(readItinerary(storage, "evt"), ["a", "b"]);

  assert.equal(writeItinerary(storage, "evt", []), true);
  assert.equal(storage.map.has(itineraryStorageKey("evt")), false);
});

test("toggling adds, removes, ignores malformed ids and refuses to grow past the cap", () => {
  assert.deepEqual(toggleItineraryId([], "a"), ["a"]);
  assert.deepEqual(toggleItineraryId(["a", "b"], "a"), ["b"]);
  assert.deepEqual(toggleItineraryId(["a"], "not an id"), ["a"]);

  const full = Array.from({ length: MAX_ITINERARY_SESSIONS }, (_, i) => `s${i}`);
  assert.equal(toggleItineraryId(full, "extra").length, MAX_ITINERARY_SESSIONS);
  // Removal still works at the cap.
  assert.equal(toggleItineraryId(full, "s0").length, MAX_ITINERARY_SESSIONS - 1);
});

test("the ics id list is bounded, deduped and stripped of anything unparseable", () => {
  assert.deepEqual(parseItinerarySessionIds(null), []);
  assert.deepEqual(parseItinerarySessionIds(""), []);
  assert.deepEqual(parseItinerarySessionIds(",,"), []);
  assert.deepEqual(parseItinerarySessionIds(" a , b ,a"), ["a", "b"]);
  // A quoted, spaced or otherwise injected value never survives into a query.
  assert.deepEqual(parseItinerarySessionIds("a';drop,b c,ok_1-2"), ["ok_1-2"]);
  assert.deepEqual(parseItinerarySessionIds("x".repeat(65)), []);
  assert.equal(
    parseItinerarySessionIds(Array.from({ length: MAX_ITINERARY_SESSIONS + 50 }, (_, i) => `s${i}`).join(",")).length,
    MAX_ITINERARY_SESSIONS,
  );
});

test("serializing round-trips through the parser and drops an empty selection", () => {
  assert.equal(serializeItinerarySessionIds([]), "");
  assert.equal(serializeItinerarySessionIds(["a", "a", "bad id", "b"]), "a,b");
  assert.deepEqual(parseItinerarySessionIds(serializeItinerarySessionIds(["a", "b"])), ["a", "b"]);
});

test("only starred sessions are listed, in start-time order", () => {
  const all = [
    session("c", "2026-05-01T12:00:00.000Z", "2026-05-01T13:00:00.000Z"),
    session("a", "2026-05-01T09:00:00.000Z", "2026-05-01T10:00:00.000Z"),
    session("b", "2026-05-01T10:00:00.000Z", "2026-05-01T11:00:00.000Z"),
  ];
  assert.deepEqual(
    itinerarySessions(all, ["c", "a", "missing"]).map((s) => s.sessionId),
    ["a", "c"],
  );
  assert.deepEqual(itinerarySessions(all, []), []);
});

test("overlaps are reported from both sides, and back-to-back talks are not overlaps", () => {
  const chosen = [
    session("a", "2026-05-01T09:00:00.000Z", "2026-05-01T10:00:00.000Z", "Opening"),
    session("b", "2026-05-01T09:30:00.000Z", "2026-05-01T10:30:00.000Z", "Types"),
    session("c", "2026-05-01T10:30:00.000Z", "2026-05-01T11:00:00.000Z", "Coffee"),
  ];
  const overlaps = itineraryOverlaps(chosen);
  assert.deepEqual(overlaps.get("a"), ["Types"]);
  assert.deepEqual(overlaps.get("b"), ["Opening"]);
  // b ends exactly when c starts: a walk between rooms, not a clash.
  assert.equal(overlaps.has("c"), false);
});

test("a three-way clash names every other session", () => {
  const chosen = [
    session("a", "2026-05-01T09:00:00.000Z", "2026-05-01T11:00:00.000Z", "A"),
    session("b", "2026-05-01T09:30:00.000Z", "2026-05-01T10:00:00.000Z", "B"),
    session("c", "2026-05-01T09:45:00.000Z", "2026-05-01T10:15:00.000Z", "C"),
  ];
  assert.deepEqual(itineraryOverlaps(chosen).get("a"), ["B", "C"]);
  assert.equal(overlapNotice(itineraryOverlaps(chosen).get("a")), "Overlaps with B and C");
});

test("the overlap notice and tab label read as sentences a reader can act on", () => {
  assert.equal(overlapNotice(undefined), null);
  assert.equal(overlapNotice([]), null);
  assert.equal(overlapNotice(["Types"]), "Overlaps with Types");
  assert.equal(overlapNotice(["A", "B", "C"]), "Overlaps with A, B and C");
  assert.equal(itineraryTabLabel(0), "My itinerary");
  assert.equal(itineraryTabLabel(3), "My itinerary (3)");
});
