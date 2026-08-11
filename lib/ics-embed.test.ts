import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { calendarExportUrl } from "./ics-embed";
import { PUBLIC_AGENDA_LIMITS } from "./embed-schedule-view";

test("builds the public event calendar export URL without a session", () => {
  assert.equal(calendarExportUrl("event-123"), "/api/comms/calendar?eventId=event-123");
});

test("builds the public single-session calendar export URL", () => {
  assert.equal(
    calendarExportUrl("event-123", "session-456"),
    "/api/comms/calendar?eventId=event-123&sessionId=session-456",
  );
});

test("§5-6: each VEVENT points at its own talk on the canonical schedule", () => {
  const route = readFileSync(new URL("../app/api/comms/calendar/route.ts", import.meta.url), "utf8");

  // The URL is the canonical page, scoped to this event, with the session's own
  // fragment. Every VEVENT used to carry the identical bare embed URL.
  assert.match(route, /publicSurfaceUrl\(CANONICAL_SCHEDULE_PATH, event\.slug\)/);
  assert.match(route, /url: scheduleUrl \? `\$\{scheduleUrl\}#session-\$\{s\.id\}` : null/);
  assert.doesNotMatch(route, /\$\{appUrl\}\/embed\/schedule/);

  // The track reaches the client as CATEGORIES, and only when there is one.
  assert.match(route, /categories: s\.scheduleSlot!\.track \? \[s\.scheduleSlot!\.track\.name\] : null/);
  assert.match(route, /track: \{ select: \{ name: true \} \}/);

  // X-WR-CALNAME on the single-session file too: an unnamed one-event .ics is
  // filed under an untitled calendar or merged into the user's default.
  assert.match(route, /calendarName: event\.name/);
  assert.doesNotMatch(route, /calendarName: sessionId \?/);
});

/**
 * NEW-1. This was the only anonymous read in the app with no `take` at all —
 * one unauthenticated GET materialized every published, placed session of an
 * event and rendered all of them into a file.
 *
 * Pinned as source because the route is a Prisma-backed handler with no
 * execution harness in `npm test`, and the smoke's fixture event is thirteen
 * sessions — three orders of magnitude below the cap, so a served assertion
 * about the cut would be vacuous. What the smoke can and does check is that the
 * bounded route still returns the whole real programme.
 *
 * CRLF-safe: no pattern below crosses a line break.
 */
test("NEW-1: the anonymous .ics export is bounded, deterministic, and says when it cut", () => {
  const route = readFileSync(new URL("../app/api/comms/calendar/route.ts", import.meta.url), "utf8");

  // One cap across all three public views of one programme, so the file, the
  // JSON twin and the embed cannot disagree about which sessions are inside it.
  assert.match(route, /take: PUBLIC_AGENDA_LIMITS\.sessions \+ 1/, "reads cap-plus-one");
  assert.match(
    route,
    /const truncated = rows\.length > PUBLIC_AGENDA_LIMITS\.sessions;/,
    "derives truncation from the probe row rather than guessing",
  );
  assert.match(
    route,
    /const sessions = rows\.slice\(0, PUBLIC_AGENDA_LIMITS\.sessions\);/,
    "exports the cap, never the probe row",
  );
  // A total order: without the id tiebreak, which sessions fall inside the cap
  // is whatever Postgres returned for two talks starting at the same minute.
  assert.match(
    route,
    /orderBy: \[\{ scheduleSlot: \{ startsAt: "asc" \} \}, \{ id: "asc" \}\]/,
    "orders totally, with an id tiebreak",
  );
  // The disclosure rides in the file itself. A downloaded .ics outlives the
  // response, so a header or JSON field could never reach the person reading it.
  assert.match(route, /calendarDescription:/, "discloses the cut inside the file");
  assert.match(route, /\.\.\.\(truncated$/m, "and only when something was actually cut");

  // The 404 must still be derived from the rendered set, not the probe read.
  assert.match(route, /if \(sessions\.length === 0\)/);
  assert.match(route, /icsFilename\(sessions\[0\]\.title\)/);
  assert.equal(/rows\.length === 0/.test(route), false);

  // The cap is a real number the builder actually has to respect.
  assert.ok(PUBLIC_AGENDA_LIMITS.sessions > 0);
});

test("NEW-1: X-WR-CALDESC is emitted only when a description is given", () => {
  const ics = readFileSync(new URL("./calendar/ics.ts", import.meta.url), "utf8");
  assert.match(ics, /if \(calendarDescription\) \{/);
  assert.match(ics, /line\("X-WR-CALDESC", escapeIcsText\(calendarDescription\)\)/);
});
