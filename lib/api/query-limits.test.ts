import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@/lib/api/http";
import { assertEventQueryBound, OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";

test("operator query bounds allow the documented limit and reject the extra sentinel row", () => {
  assert.equal(OPERATOR_QUERY_LIMITS.sessionSpeakersPerSession, 100);
  assert.equal(OPERATOR_QUERY_LIMITS.openTasksPerReminderSpeaker, 500);
  assert.equal(OPERATOR_QUERY_LIMITS.settingsRooms, 500);
  assert.equal(OPERATOR_QUERY_LIMITS.settingsTracks, 250);
  assert.equal(OPERATOR_QUERY_LIMITS.settingsCategories, 1_000);
  assert.doesNotThrow(() =>
    assertEventQueryBound({ length: OPERATOR_QUERY_LIMITS.templates }, OPERATOR_QUERY_LIMITS.templates, "templates"),
  );
  assert.throws(
    () => assertEventQueryBound({ length: OPERATOR_QUERY_LIMITS.templates + 1 }, OPERATOR_QUERY_LIMITS.templates, "templates"),
    (error: unknown) =>
      error instanceof ApiError &&
      error.code === "EVENT_QUERY_LIMIT_EXCEEDED" &&
      error.message.includes(String(OPERATOR_QUERY_LIMITS.templates)),
  );
});
