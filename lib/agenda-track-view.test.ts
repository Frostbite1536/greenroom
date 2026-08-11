import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  NO_TRACK_COLOR,
  NO_TRACK_NAME,
  groupByTrack,
  trackViewEmptyCopy,
} from "@/lib/agenda-track-view";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const track = (id: string, name = id.toUpperCase()) => ({ id, name, color: "#123456" });
const session = (title: string, trackId: string | null, startsAt: string) => ({
  title,
  slot: { trackId, startsAt },
});

test("every configured track gets a group, in the caller's order, even when empty", () => {
  const groups = groupByTrack([session("Only talk", "b", "2026-05-01T09:00:00.000Z")], [
    track("a"),
    track("b"),
    track("c"),
  ]);

  assert.deepEqual(groups.map((g) => g.trackId), ["a", "b", "c"]);
  assert.deepEqual(groups.map((g) => g.sessions.length), [0, 1, 0]);
  // The heading carries the operator's own name and colour, not a re-derivation.
  assert.equal(groups[1].name, "B");
  assert.equal(groups[1].color, "#123456");
});

test("sessions inside a track are ordered by start time, then title", () => {
  const groups = groupByTrack(
    [
      session("Zebra", "a", "2026-05-01T11:00:00.000Z"),
      session("Later", "a", "2026-05-01T14:00:00.000Z"),
      session("Alpha", "a", "2026-05-01T11:00:00.000Z"),
      session("Earliest", "a", "2026-05-01T09:00:00.000Z"),
    ],
    [track("a")],
  );

  assert.deepEqual(groups[0].sessions.map((s) => s.title), ["Earliest", "Alpha", "Zebra", "Later"]);
});

test("the fold spans the whole programme, not one day", () => {
  const groups = groupByTrack(
    [
      session("Day two", "a", "2026-05-02T09:00:00.000Z"),
      session("Day one", "a", "2026-05-01T16:00:00.000Z"),
    ],
    [track("a")],
  );

  assert.deepEqual(groups[0].sessions.map((s) => s.title), ["Day one", "Day two"]);
});

test("a talk placed without a track lands in a trailing No track bucket", () => {
  const groups = groupByTrack(
    [
      session("Untracked", null, "2026-05-01T09:00:00.000Z"),
      session("Tracked", "a", "2026-05-01T10:00:00.000Z"),
    ],
    [track("a")],
  );

  assert.equal(groups.length, 2);
  // Last, so the configured tracks keep their own order at the top.
  const bucket = groups[groups.length - 1];
  assert.equal(bucket.trackId, null);
  assert.equal(bucket.name, NO_TRACK_NAME);
  assert.equal(bucket.color, NO_TRACK_COLOR);
  assert.deepEqual(bucket.sessions.map((s) => s.title), ["Untracked"]);
});

test("the No track bucket is omitted when every talk has a track", () => {
  const groups = groupByTrack([session("Tracked", "a", "2026-05-01T09:00:00.000Z")], [track("a")]);
  assert.deepEqual(groups.map((g) => g.trackId), ["a"]);
});

test("a talk whose track was deleted is reported, not dropped", () => {
  // The day grid matches slots to track columns by id, so this talk renders
  // nowhere there. Losing a scheduled talk from a schedule view is the failure
  // this bucket exists to prevent.
  const groups = groupByTrack(
    [session("Orphaned", "deleted-track", "2026-05-01T09:00:00.000Z")],
    [track("a")],
  );

  const bucket = groups[groups.length - 1];
  assert.equal(bucket.trackId, null);
  assert.deepEqual(bucket.sessions.map((s) => s.title), ["Orphaned"]);
  // Every placed talk appears exactly once across the whole fold.
  assert.equal(groups.reduce((n, g) => n + g.sessions.length, 0), 1);
});

test("with no tracks configured, everything placed is grouped as untracked", () => {
  const groups = groupByTrack(
    [
      session("B", null, "2026-05-01T10:00:00.000Z"),
      session("A", null, "2026-05-01T09:00:00.000Z"),
    ],
    [],
  );

  assert.equal(groups.length, 1);
  assert.equal(groups[0].trackId, null);
  assert.deepEqual(groups[0].sessions.map((s) => s.title), ["A", "B"]);
});

test("grouping never drops or duplicates a placed talk", () => {
  const sessions = [
    session("one", "a", "2026-05-01T09:00:00.000Z"),
    session("two", "b", "2026-05-01T09:00:00.000Z"),
    session("three", null, "2026-05-01T09:00:00.000Z"),
    session("four", "gone", "2026-05-01T09:00:00.000Z"),
    session("five", "a", "2026-05-01T09:30:00.000Z"),
  ];
  const groups = groupByTrack(sessions, [track("a"), track("b")]);
  const titles = groups.flatMap((g) => g.sessions.map((s) => s.title)).sort();

  assert.deepEqual(titles, ["five", "four", "one", "three", "two"]);
});

test("the empty copy tells an organizer with no tracks to add tracks", () => {
  const copy = trackViewEmptyCopy(groupByTrack([], []));
  assert.equal(copy?.title, "No tracks yet");
  assert.match(copy?.detail ?? "", /event settings/i);
});

test("the empty copy does not tell an organizer who has tracks to add tracks", () => {
  const copy = trackViewEmptyCopy(groupByTrack([], [track("a")]));
  assert.equal(copy?.title, "Nothing scheduled yet");
  assert.doesNotMatch(copy?.detail ?? "", /event settings/i);
  assert.match(copy?.detail ?? "", /backlog/i);
});

test("a view with anything placed gets no empty copy at all", () => {
  const groups = groupByTrack([session("Talk", "a", "2026-05-01T09:00:00.000Z")], [track("a"), track("b")]);
  // `b` is empty, but the view as a whole is not.
  assert.equal(trackViewEmptyCopy(groups), null);
});

test("the Tracks view is read-only and goes through the shared fold", () => {
  const builder = source("components/agenda-builder.tsx");

  // Read-only like the week view: no drag handler and no write call inside it.
  const view = builder.match(/function TracksView\([\s\S]*?\r?\n\}\r?\n/)?.[0] ?? "";
  assert.notEqual(view, "", "TracksView must exist in the agenda builder");
  // The slice has to reach the end of the component, or every `doesNotMatch`
  // below would pass by simply not having read far enough.
  assert.match(view, /Unpublished/, "the extracted component must span its whole body");
  assert.doesNotMatch(view, /onDrop|onDragStart|apiPost|apiPatch|apiDelete/);

  // The grouping is not restated in the component.
  assert.match(builder, /groupByTrack\(/);
  assert.doesNotMatch(view, /\.sort\(/);
});
