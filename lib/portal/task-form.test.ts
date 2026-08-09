import assert from "node:assert/strict";
import { test } from "node:test";
import {
  completionBlocked,
  mergeTaskResponses,
  normalizeStoredResponses,
  pruneToFields,
  taskUpdateWithResponsesSchema,
  validateTaskResponses,
  type TaskFormField,
} from "./task-form";

function field(key: string, required = true, overrides: Partial<TaskFormField> = {}): TaskFormField {
  return {
    id: `f-${key}`, key, label: key.replace(/_/g, " "), helpText: null, type: "SHORT_TEXT",
    required, options: null, conditionalLogic: null, sortOrder: 0, ...overrides,
  };
}

const hotelFields = [field("needs_hotel"), field("check_in", false), field("hotel_notes", false)];

test("stored responses are normalized rather than trusted", () => {
  assert.deepEqual(normalizeStoredResponses(null), {});
  assert.deepEqual(normalizeStoredResponses("nonsense"), {});
  assert.deepEqual(normalizeStoredResponses(["a"]), {});
  assert.deepEqual(normalizeStoredResponses({ needs_hotel: "yes" }), { needs_hotel: "yes" });
});

test("a partial save never wipes an earlier answer", () => {
  const merged = mergeTaskResponses({ needs_hotel: "yes", check_in: "11 May" }, { hotel_notes: "Late arrival" });
  assert.deepEqual(merged, { needs_hotel: "yes", check_in: "11 May", hotel_notes: "Late arrival" });
  // Sending null is how you deliberately clear one.
  assert.deepEqual(mergeTaskResponses({ check_in: "11 May" }, { check_in: null }), { check_in: null });
});

test("answers to deleted fields are dropped instead of lingering", () => {
  const pruned = pruneToFields({ needs_hotel: "yes", removed_field: "x" }, hotelFields);
  assert.deepEqual(pruned, { needs_hotel: "yes" });
});

test("a form-carrying task cannot be completed with its required questions blank", () => {
  const blocked = completionBlocked({ hasForm: true, nextStatus: "COMPLETED", fields: hotelFields, responses: {} });
  assert.equal(blocked?.code, "FIELD_ERRORS");
  assert.ok(blocked?.fieldErrors?.needs_hotel);
  // Optional questions never block completion.
  assert.equal(completionBlocked({ hasForm: true, nextStatus: "COMPLETED", fields: hotelFields, responses: { needs_hotel: "yes" } }), null);
});

test("whitespace and empty selections do not count as answers", () => {
  for (const value of ["", "   ", null, []]) {
    const blocked = validateTaskResponses(hotelFields, { needs_hotel: value as never });
    assert.equal(blocked?.code, "FIELD_ERRORS", JSON.stringify(value));
  }
});

test("saving progress is always allowed, even with a blank form", () => {
  assert.equal(completionBlocked({ hasForm: true, nextStatus: "IN_PROGRESS", fields: hotelFields, responses: {} }), null);
  assert.equal(completionBlocked({ hasForm: true, nextStatus: "TODO", fields: hotelFields, responses: {} }), null);
});

test("a task without a form is completed the ordinary way", () => {
  assert.equal(completionBlocked({ hasForm: false, nextStatus: "COMPLETED", fields: [], responses: {} }), null);
});

test("the update schema accepts responses without weakening the locked task contract", () => {
  const ok = taskUpdateWithResponsesSchema.safeParse({
    taskId: "task-1", status: "COMPLETED",
    responses: { needs_hotel: "yes", amount: 720, claiming_travel: true, tags: ["a", "b"], cleared: null },
  });
  assert.equal(ok.success, true);
  // Status values still come from the shared schema.
  assert.equal(taskUpdateWithResponsesSchema.safeParse({ taskId: "t", status: "NONSENSE" }).success, false);
  // Response keys are constrained. Note the payload is built with JSON.parse,
  // not an object literal: `{"__proto__": x}` as a literal sets the prototype
  // and creates no own key, so a literal would vacuously pass and prove nothing.
  const smuggled = JSON.parse('{"taskId":"t","status":"TODO","responses":{"__proto__":"x"}}');
  assert.equal(taskUpdateWithResponsesSchema.safeParse(smuggled).success, false);
  assert.equal(taskUpdateWithResponsesSchema.safeParse({ taskId: "t", status: "TODO", responses: { "Bad-Key": "x" } }).success, false);
});

test("oversized answers are refused before they reach the database", () => {
  assert.equal(
    taskUpdateWithResponsesSchema.safeParse({ taskId: "t", status: "TODO", responses: { notes: "x".repeat(5_001) } }).success,
    false,
  );
  assert.equal(
    taskUpdateWithResponsesSchema.safeParse({ taskId: "t", status: "TODO", responses: { tags: Array.from({ length: 51 }, () => "a") } }).success,
    false,
  );
});
