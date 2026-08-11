import assert from "node:assert/strict";
import { test } from "node:test";
import {
  conflictTitle,
  describeScheduleConflict,
  describeScheduleConflicts,
  type ConflictNaming,
} from "@/lib/services/schedule-conflict-copy";

const LA = "America/Los_Angeles";

const roomConflict = (over: Partial<ConflictNaming> = {}): ConflictNaming => ({
  type: "ROOM_OVERLAP",
  roomName: "Hall A",
  sessionTitle: "Scaling Vector Search",
  startsAt: "2026-05-12T17:00:00.000Z",
  endsAt: "2026-05-12T17:45:00.000Z",
  speakerName: null,
  timeZone: LA,
  ...over,
});

test("a room conflict names the room, the occupying talk and the time range", () => {
  assert.equal(
    describeScheduleConflict(roomConflict()),
    "Room conflict: Hall A is occupied by “Scaling Vector Search” from 10:00 AM–10:45 AM PDT.",
  );
});

test("a speaker conflict names the person, the talk and the room", () => {
  const copy = describeScheduleConflict(
    roomConflict({ type: "SPEAKER_OVERLAP", speakerName: "Priya Raman" }),
  );
  assert.match(copy, /^Speaker conflict: Priya Raman is already speaking in /);
  assert.match(copy, /“Scaling Vector Search”/);
  assert.match(copy, /in Hall A from 10:00 AM–10:45 AM PDT\./);
});

test("times are the event's clock, not the reader's", () => {
  // Same instant, two event timezones: the sentence must follow the event.
  const la = describeScheduleConflict(roomConflict());
  const tokyo = describeScheduleConflict(roomConflict({ timeZone: "Asia/Tokyo" }));
  assert.match(la, /10:00 AM–10:45 AM PDT/);
  assert.match(tokyo, /2:00 AM–2:45 AM/);
  assert.notEqual(la, tokyo);
});

test("a long title is trimmed on a word boundary and never mid-word", () => {
  const long = "Scaling Vector Search Across Seventeen Regions Without Losing Your Mind";
  const trimmed = conflictTitle(long);
  assert.ok(trimmed.endsWith("…”"), trimmed);
  assert.ok(trimmed.length < long.length);
  const inner = trimmed.slice(1, -2);
  assert.ok(long.startsWith(inner), `“${inner}” is not a prefix of the real title`);
  assert.ok(!inner.endsWith(" "), "the ellipsis must not follow a space");
});

test("a short title is quoted whole, with no ellipsis", () => {
  assert.equal(conflictTitle("Keynote"), "“Keynote”");
});

test("missing names degrade to honest wording instead of blanks", () => {
  assert.equal(conflictTitle("   "), "an untitled session");
  const nameless = describeScheduleConflict(
    roomConflict({ type: "SPEAKER_OVERLAP", speakerName: "  ", roomName: "" }),
  );
  assert.match(nameless, /^Speaker conflict: A speaker on this talk is already speaking/);
  assert.match(nameless, /in That room from/);
  assert.ok(!nameless.includes("  in"), nameless);
});

test("a slot with no stored end still gets a labelled start", () => {
  const copy = describeScheduleConflict(roomConflict({ endsAt: null }));
  assert.match(copy, /from 10:00 AM PDT\.$/);
});

test("every conflict produces a sentence, in detection order", () => {
  const sentences = describeScheduleConflicts([
    roomConflict(),
    roomConflict({ type: "SPEAKER_OVERLAP", speakerName: "Sam Whitfield", sessionTitle: "Second Talk" }),
  ]);
  assert.equal(sentences.length, 2);
  assert.match(sentences[0], /^Room conflict:/);
  assert.match(sentences[1], /^Speaker conflict: Sam Whitfield/);
  for (const sentence of sentences) assert.ok(sentence.endsWith("."), sentence);
});
