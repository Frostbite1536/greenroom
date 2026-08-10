import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL,
  DESCRIPTION_PREVIEW_CHARS,
  MAX_EVENT_DAYS,
  PUBLIC_AGENDA_LIMITS,
  agendaTruncationNotice,
  chipPrefix,
  dayTabs,
  descriptionPreview,
  eventDayKeys,
  filterSessions,
  groupByDay,
  matchesQuery,
  resolveDay,
  resolveQuery,
  resolveTrack,
  resultSummary,
  scheduleHref,
  sessionChips,
  type ScheduleViewAgenda,
  type ScheduleViewSession,
} from "./embed-schedule-view";
import { formatDayLabel } from "./tz";

const LOS_ANGELES = "America/Los_Angeles";

const engineering = { id: "track-eng", name: "Engineering", color: "#2f6f4e" };
const design = { id: "track-design", name: "Design", color: "#7a4fb5" };

function session(overrides: Partial<ScheduleViewSession> = {}): ScheduleViewSession {
  return {
    slotId: "slot-1",
    sessionId: "session-1",
    title: "Scaling to 10M requests",
    description: "How we grew the platform.",
    format: "Keynote",
    room: { id: "room-1", name: "Redwood Hall" },
    track: engineering,
    startsAt: "2026-05-12T17:00:00.000Z",
    endsAt: "2026-05-12T17:45:00.000Z",
    speakers: ["Elena Rodriguez"],
    ...overrides,
  };
}

/** Seeded shape: a three-day Los Angeles event with nothing on the last day. */
function agenda(overrides: Partial<ScheduleViewAgenda> = {}): ScheduleViewAgenda {
  return {
    event: {
      id: "event-1",
      name: "Forward 2026",
      slug: "forward-2026",
      timezone: LOS_ANGELES,
      startsAt: "2026-05-12T07:00:00.000Z",
      endsAt: "2026-05-15T06:59:00.000Z",
    },
    tracks: [engineering, design],
    sessions: [
      session(),
      session({
        slotId: "slot-2",
        sessionId: "session-2",
        title: "Designing for trust",
        description: "Interface patterns.",
        format: "Workshop",
        track: design,
        room: { id: "room-2", name: "Cedar Room" },
        startsAt: "2026-05-13T18:30:00.000Z",
        endsAt: "2026-05-13T19:30:00.000Z",
        speakers: ["Sofia Marques"],
      }),
    ],
    ...overrides,
  };
}

test("day tabs come from the event date range, so an empty last day is still reachable", () => {
  const tabs = dayTabs(agenda(), { track: ALL, day: ALL, q: "" }, formatDayLabel);

  assert.deepEqual(tabs.map((tab) => tab.key), ["2026-05-12", "2026-05-13", "2026-05-14"]);
  // The third day holds nothing. Deriving tabs from placed sessions — the old
  // behaviour — made that day unreachable rather than empty.
  assert.deepEqual(tabs.map((tab) => tab.count), [1, 1, 0]);
  assert.deepEqual(tabs.map((tab) => tab.label), ["Tue, May 12", "Wed, May 13", "Thu, May 14"]);
});

test("a session placed outside the stored event range still gets a tab", () => {
  const stray = session({ slotId: "slot-3", sessionId: "session-3", startsAt: "2026-05-16T17:00:00.000Z", endsAt: "2026-05-16T18:00:00.000Z" });
  const tabs = dayTabs(
    agenda({ sessions: [...agenda().sessions, stray] }),
    { track: ALL, day: ALL, q: "" },
    formatDayLabel,
  );
  assert.deepEqual(tabs.map((tab) => tab.key), ["2026-05-12", "2026-05-13", "2026-05-14", "2026-05-16"]);
});

test("day keys fall back to session days when the event carries no dates", () => {
  const keys = eventDayKeys(agenda({ event: { ...agenda().event, startsAt: null, endsAt: null } }));
  assert.deepEqual(keys, ["2026-05-12", "2026-05-13"]);
});

test("an absurd event range is bounded instead of generating unlimited tabs", () => {
  const keys = eventDayKeys(agenda({
    event: { ...agenda().event, startsAt: "2026-05-12T07:00:00.000Z", endsAt: "2030-05-12T07:00:00.000Z" },
    sessions: [],
  }));
  assert.equal(keys.length, MAX_EVENT_DAYS);
});

test("day tab counts respect the track filter but never the day itself", () => {
  const tabs = dayTabs(agenda(), { track: design.id, day: "2026-05-12", q: "" }, formatDayLabel);
  assert.deepEqual(tabs.map((tab) => tab.count), [0, 1, 0]);
  assert.deepEqual(tabs.map((tab) => tab.current), [true, false, false]);
});

test("search matches title, speaker, description, format, track and room", () => {
  const target = session();
  assert.equal(matchesQuery(target, "scaling"), true);
  assert.equal(matchesQuery(target, "elena"), true);
  assert.equal(matchesQuery(target, "grew the platform"), true);
  assert.equal(matchesQuery(target, "keynote"), true);
  assert.equal(matchesQuery(target, "engineering"), true);
  assert.equal(matchesQuery(target, "redwood"), true);
  assert.equal(matchesQuery(target, "quantum"), false);
  // An empty query must not filter anything out.
  assert.equal(matchesQuery(target, ""), true);
});

test("search narrows the listing and composes with track and day", () => {
  const data = agenda();
  assert.deepEqual(
    filterSessions(data, { track: ALL, q: "trust" }).map((s) => s.sessionId),
    ["session-2"],
  );
  assert.deepEqual(
    filterSessions(data, { track: engineering.id, q: "trust" }).map((s) => s.sessionId),
    [],
  );
  assert.deepEqual(
    filterSessions(data, { track: ALL, q: "", day: "2026-05-14" }).map((s) => s.sessionId),
    [],
  );
  assert.deepEqual(
    filterSessions(data, { track: ALL, q: "", day: "2026-05-13" }).map((s) => s.sessionId),
    ["session-2"],
  );
});

test("unknown track, day and oversized query values degrade to the unfiltered view", () => {
  const data = agenda();
  assert.equal(resolveTrack(data, "track-does-not-exist"), ALL);
  assert.equal(resolveTrack(data, design.id), design.id);
  assert.equal(resolveTrack(data, undefined), ALL);
  assert.equal(resolveDay(eventDayKeys(data), "1999-01-01"), ALL);
  assert.equal(resolveDay(eventDayKeys(data), "2026-05-14"), "2026-05-14");
  assert.equal(resolveQuery("  edge  "), "edge");
  assert.equal(resolveQuery("x".repeat(500)).length, 200);
});

test("descriptions expose a word-boundary preview and flag that more text exists", () => {
  const long = `${"word ".repeat(80)}tail`;
  const split = descriptionPreview(long)!;
  assert.equal(split.truncated, true);
  assert.ok(split.preview.length <= DESCRIPTION_PREVIEW_CHARS);
  assert.equal(split.preview.endsWith(" "), false);
  assert.ok(long.startsWith(split.preview));

  const short = descriptionPreview("Short and complete.")!;
  assert.deepEqual(short, { preview: "Short and complete.", truncated: false });
  assert.equal(descriptionPreview(null), null);
  assert.equal(descriptionPreview("   "), null);
});

test("chips carry format, track and room as text, never colour alone", () => {
  assert.deepEqual(sessionChips(session()), [
    { kind: "format", label: "Keynote" },
    { kind: "track", label: "Engineering" },
    { kind: "room", label: "Redwood Hall" },
  ]);
  // A session with no format or track still names its room.
  assert.deepEqual(sessionChips(session({ format: null, track: null })), [
    { kind: "room", label: "Redwood Hall" },
  ]);
});

test("an accept-created talk with no schedule track is labelled by its topic", () => {
  // The defect this closes: a session provisioned from an accepted abstract has
  // no slot track, so it rendered a grey rail and no words at all.
  assert.deepEqual(
    sessionChips(session({ format: null, track: null, category: { id: "cat-1", name: "Developer Experience" } })),
    [
      { kind: "topic", label: "Developer Experience" },
      { kind: "room", label: "Redwood Hall" },
    ],
  );
});

test("a topic is its own chip, never printed under the track's label", () => {
  assert.deepEqual(
    sessionChips(session({ category: { id: "cat-1", name: "Developer Experience" } })),
    [
      { kind: "format", label: "Keynote" },
      { kind: "track", label: "Engineering" },
      { kind: "topic", label: "Developer Experience" },
      { kind: "room", label: "Redwood Hall" },
    ],
  );
  assert.equal(chipPrefix("topic"), "Topic");
  assert.equal(chipPrefix("track"), "Track");
  assert.equal(chipPrefix("format"), "Format");
  assert.equal(chipPrefix("room"), "Room");
});

test("a blank or missing topic adds no chip", () => {
  assert.equal(sessionChips(session({ category: null })).some((chip) => chip.kind === "topic"), false);
  assert.equal(
    sessionChips(session({ category: { id: "cat-1", name: "   " } })).some((chip) => chip.kind === "topic"),
    false,
  );
});

test("a complete agenda renders no truncation notice at all", () => {
  assert.equal(agendaTruncationNotice({ sessions: [session()], truncated: false }), null);
  // An older caller that predates the bound is not accused of being cut.
  assert.equal(agendaTruncationNotice({ sessions: [session()] }), null);
});

test("a cut agenda says how many it is showing and how to narrow it", () => {
  const notice = agendaTruncationNotice({
    sessions: [session(), session({ slotId: "slot-2" })],
    truncated: true,
  });
  assert.match(notice ?? "", /only the first 2 sessions/);
  assert.match(notice ?? "", /day tabs or search/);
});

test("the public agenda bound is a real number the reads can page against", () => {
  assert.equal(typeof PUBLIC_AGENDA_LIMITS.sessions, "number");
  assert.ok(PUBLIC_AGENDA_LIMITS.sessions > 0);
});

test("keyword search reaches a session's topic", () => {
  const talk = session({ track: null, category: { id: "cat-1", name: "Developer Experience" } });
  assert.equal(matchesQuery(talk, "developer experience"), true);
  assert.equal(matchesQuery(talk, "accessibility"), false);
});

test("filter links keep the event parameter byte-identical and drop defaults", () => {
  const filters = { track: engineering.id, day: "2026-05-13", q: "edge" };
  assert.equal(
    scheduleHref("forward-2026", filters),
    "/embed/schedule?event=forward-2026&track=track-eng&day=2026-05-13&q=edge",
  );
  assert.equal(
    scheduleHref("forward-2026", filters, { day: ALL }),
    "/embed/schedule?event=forward-2026&track=track-eng&q=edge",
  );
  assert.equal(
    scheduleHref(undefined, { track: ALL, day: ALL, q: "" }),
    "/embed/schedule",
  );
  // An id-form event param is echoed, not normalised to a slug.
  assert.equal(
    scheduleHref("event-1", { track: ALL, day: ALL, q: "" }),
    "/embed/schedule?event=event-1",
  );
});

test("grouping orders days and sessions by start time", () => {
  const late = session({ slotId: "slot-4", sessionId: "session-4", startsAt: "2026-05-12T19:00:00.000Z" });
  const grouped = groupByDay([late, ...agenda().sessions], LOS_ANGELES);
  assert.deepEqual(grouped.map(([key]) => key), ["2026-05-12", "2026-05-13"]);
  assert.deepEqual(grouped[0]![1].map((s) => s.sessionId), ["session-1", "session-4"]);
});

test("the header summary states how many of the total are showing", () => {
  assert.equal(resultSummary(18, 18, false), "18 sessions");
  assert.equal(resultSummary(18, 3, true), "3 sessions of 18");
  assert.equal(resultSummary(1, 1, false), "1 session");
});
