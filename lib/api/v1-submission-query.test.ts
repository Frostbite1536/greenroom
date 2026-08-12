import assert from "node:assert/strict";
import test from "node:test";
import { parseV1SubmissionId, parseV1SubmissionQuery } from "@/lib/api/v1-submission-query";

test("submission status is an explicit bounded browse filter", () => {
  assert.deepEqual(parseV1SubmissionQuery(new URLSearchParams("status=ACCEPTED")), {
    ok: true, value: "ACCEPTED",
  });
  const invalid = parseV1SubmissionQuery(new URLSearchParams("status=anything"));
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, "INVALID_QUERY");
});

test("omitted status preserves the existing browse contract", () => {
  assert.deepEqual(parseV1SubmissionQuery(new URLSearchParams()), { ok: true, value: null });
});

test("submission ids are bounded before an item lookup", () => {
  assert.deepEqual(parseV1SubmissionId("abstract-1"), { ok: true, value: "abstract-1" });
  assert.equal(parseV1SubmissionId("").ok, false);
  assert.equal(parseV1SubmissionId("x".repeat(192)).ok, false);
});
