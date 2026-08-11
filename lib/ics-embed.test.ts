import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { calendarExportUrl } from "./ics-embed";

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
