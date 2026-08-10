import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formConfigInputSchema } from "@/types/api";
import { LOGIC_OPERATORS } from "@/lib/services/form-shape-validation";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("the shape contract runs for create and update, inside the lock order and before any mutation", () => {
  const route = source("app/api/cfp/forms/route.ts");
  const write = route.slice(route.indexOf("export const POST"), route.indexOf("function assertFormShapeIsCoherent"));

  // One call, unconditional inside the write transaction: `input.id` only
  // decides whether a stored parent row exists to lock, so both the create and
  // the update branch reach the same enforcement.
  assert.equal(write.split("assertFormShapeIsCoherent(").length - 1, 1);
  assert.ok(write.indexOf("lockFormConfigForShapeWrite") < write.indexOf("assertFormShapeIsCoherent("));
  assert.ok(write.indexOf("assertFormShapeIsCoherent(") < write.indexOf("tx.formConfig.upsert"));
  assert.ok(write.indexOf("assertFormShapeIsCoherent(") < write.indexOf("tx.formField.deleteMany"));
  assert.ok(write.indexOf("assertFormShapeIsCoherent(") < write.indexOf("tx.formField.upsert"));

  // It composes with, rather than replaces, the existing refusals.
  assert.match(route, /findDuplicateFieldKeys\(input\.fields\)/);
  assert.ok(route.indexOf("assertAnswersNotDestroyed") < route.indexOf("tx.formField.deleteMany"));
  assert.match(route, /new ApiError\(400, first\.code, first\.message, formShapeFieldErrors\(issues\)\)/);
});

test("the request schema's operator enum and the shared allowlist cannot drift apart", () => {
  for (const operator of LOGIC_OPERATORS) {
    const parsed = formConfigInputSchema.safeParse({
      eventId: "demo-event",
      name: "Form",
      slug: "form",
      minSpeakers: 1,
      maxSpeakers: 1,
      maxBioLength: 500,
      published: false,
      fields: [
        {
          key: "gate",
          label: "Gate",
          type: "SHORT_TEXT",
          sortOrder: 0,
          conditionalLogic: { match: "all", rules: [{ fieldKey: "title", operator, value: "x" }] },
        },
      ],
    });
    assert.equal(parsed.success, true, operator);
  }
});
