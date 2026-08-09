import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@/lib/api/http";
import { requireEventOwnedRow } from "@/lib/services/event-owned-row";

for (const [resourceName, code] of [
  ["Category", "CATEGORY_NOT_FOUND"],
  ["Plan", "PLAN_NOT_FOUND"],
  ["Room", "ROOM_NOT_FOUND"],
  ["Form", "FORM_NOT_FOUND"],
  ["Template", "TEMPLATE_NOT_FOUND"],
] as const) {
  test(`${resourceName.toLowerCase()} updates only accept a locked row in the caller event`, () => {
    const owned = { id: "owned", eventId: "event-a" };
    assert.equal(requireEventOwnedRow(owned, "event-a", code, resourceName), owned);

    for (const row of [undefined, null, { id: "other", eventId: "event-b" }]) {
      assert.throws(
        () => requireEventOwnedRow(row, "event-a", code, resourceName),
        (error: unknown) =>
          error instanceof ApiError &&
          error.status === 404 &&
          error.code === code &&
          error.message === `${resourceName} not found.`,
      );
    }
  });
}
