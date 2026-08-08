import assert from "node:assert/strict";
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
