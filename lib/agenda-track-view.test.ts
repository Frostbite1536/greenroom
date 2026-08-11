import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  NO_TRACK_COLOR,
  NO_TRACK_COLUMN_ID,
  NO_TRACK_NAME,
  groupByTrack,
  knownTrackIds,
  trackGridColumnFor,
  trackGridColumns,
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

test("the track grid gains a No track column when a placed talk has no track", () => {
  const columns = trackGridColumns(
    [track("a"), track("b")],
    [
      session("Tracked", "a", "2026-05-01T09:00:00.000Z"),
      session("Untracked", null, "2026-05-01T10:00:00.000Z"),
    ],
  );

  assert.deepEqual(columns.map((c) => c.id), ["a", "b", NO_TRACK_COLUMN_ID]);
  assert.equal(columns[columns.length - 1].name, NO_TRACK_NAME);
});

test("the track grid keeps exactly its configured columns when everything is tracked", () => {
  const columns = trackGridColumns(
    [track("a"), track("b")],
    [session("Tracked", "a", "2026-05-01T09:00:00.000Z")],
  );

  assert.deepEqual(columns.map((c) => c.id), ["a", "b"]);
});

test("a placed talk whose track was deleted still gets a grid column", () => {
  const columns = trackGridColumns([track("a")], [session("Orphan", "gone", "2026-05-01T09:00:00.000Z")]);
  assert.deepEqual(columns.map((c) => c.id), ["a", NO_TRACK_COLUMN_ID]);
});

test("an event with no tracks still shows its placed talks in one column", () => {
  // Before this the grid rendered the "no tracks configured" empty state and
  // the scheduled talks were simply not on the page.
  const columns = trackGridColumns([], [session("Placed", null, "2026-05-01T09:00:00.000Z")]);
  assert.deepEqual(columns.map((c) => c.id), [NO_TRACK_COLUMN_ID]);
});

test("every placed talk resolves to exactly one existing grid column", () => {
  const tracks = [track("a"), track("b")];
  const sessions = [
    session("one", "a", "2026-05-01T09:00:00.000Z"),
    session("two", "b", "2026-05-01T09:00:00.000Z"),
    session("three", null, "2026-05-01T09:00:00.000Z"),
    session("four", "deleted", "2026-05-01T09:00:00.000Z"),
  ];
  const columns = trackGridColumns(tracks, sessions);
  const known = knownTrackIds(tracks);
  const columnIds = new Set(columns.map((c) => c.id));

  for (const s of sessions) {
    const target = trackGridColumnFor(s.slot.trackId, known);
    assert.ok(columnIds.has(target), `${s.title} must land in a rendered column`);
  }
  // The untracked pair share the one bucket column.
  assert.equal(trackGridColumnFor(null, known), NO_TRACK_COLUMN_ID);
  assert.equal(trackGridColumnFor("deleted", known), NO_TRACK_COLUMN_ID);
  assert.equal(trackGridColumnFor("a", known), "a");
});

test("the sentinel column id cannot be mistaken for a track id", () => {
  // Bracketed underscores: a cuid is alphanumeric, so no real track collides.
  assert.doesNotMatch(NO_TRACK_COLUMN_ID, /^[a-z0-9]+$/i);
});

test("the track grid filter goes through the shared resolver, not a bare id match", () => {
  const builder = source("components/agenda-builder.tsx");

  assert.match(builder, /trackGridColumns\(data\.tracks, placed\)/);
  assert.match(builder, /trackGridColumnFor\(s\.slot\.trackId, known\)/);
  // The filter this replaced is what made an untracked talk invisible.
  assert.doesNotMatch(builder, /s\.slot\.trackId === col\.id/);
});

test("the Day tab names the columns it lays out", () => {
  const builder = source("components/agenda-builder.tsx");
  assert.match(builder, /label="Day \(rooms\)"/);
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
