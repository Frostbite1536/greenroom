import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@/lib/api/http";
import { assertEventQueryBound, OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";

test("operator query bounds allow the documented limit and reject the extra sentinel row", () => {
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
