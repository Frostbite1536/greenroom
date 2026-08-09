import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_ABSTRACT_LIST_TAKE,
  adminAbstractListOrderBy,
  adminAbstractListWhere,
  toAdminAbstractListEnvelope,
} from "./admin-abstract-list";
import { OPERATOR_QUERY_LIMITS } from "./query-limits";

test("admin abstract list keeps event and optional status/form filters server-side", () => {
  assert.deepEqual(adminAbstractListWhere({
    eventId: "event-1", statuses: ["SUBMITTED", "UNDER_REVIEW"], formConfigId: "form-1",
  }), {
    eventId: "event-1",
    status: { in: ["SUBMITTED", "UNDER_REVIEW"] },
    formConfigId: "form-1",
  });
  assert.deepEqual(adminAbstractListWhere({ eventId: "event-1" }), { eventId: "event-1" });
  assert.deepEqual(adminAbstractListOrderBy, [
    { submittedAt: { sort: "desc", nulls: "last" } },
    { createdAt: "desc" },
    { id: "desc" },
  ]);
});

test("admin abstract list returns a bounded honest envelope rather than silently truncating", () => {
  const rows = Array.from({ length: OPERATOR_QUERY_LIMITS.adminAbstracts + 1 }, (_, index) => `abstract-${index}`);
  const page = toAdminAbstractListEnvelope(rows, 241);
  assert.equal(page.abstracts.length, OPERATOR_QUERY_LIMITS.adminAbstracts);
  assert.equal(page.abstracts[0], "abstract-0");
  assert.equal(page.total, 241);
  assert.equal(page.hasMore, true);
  assert.equal(ADMIN_ABSTRACT_LIST_TAKE, OPERATOR_QUERY_LIMITS.adminAbstracts + 1);
  assert.deepEqual(toAdminAbstractListEnvelope(["only"], 1), {
    abstracts: ["only"], total: 1, hasMore: false,
  });
});
