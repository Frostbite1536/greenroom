import assert from "node:assert/strict";
import test from "node:test";
import { publicAbstractUpsertSchema } from "./api";

const validPublicSubmission = {
  formConfigId: "form-1",
  title: "Bounded public proposal",
  speakers: [{ email: "speaker@example.test", name: "Speaker", isPrimary: true }],
  answers: { short_answer: "ok", topics: ["one", "two"] },
  intent: "saveDraft" as const,
};

test("public submission schema is strict at both the top level and speaker objects", () => {
  assert.equal(publicAbstractUpsertSchema.safeParse(validPublicSubmission).success, true);
  assert.equal(publicAbstractUpsertSchema.safeParse({ ...validPublicSubmission, role: "ADMIN" }).success, false);
  assert.equal(publicAbstractUpsertSchema.safeParse({
    ...validPublicSubmission,
    speakers: [{ ...validPublicSubmission.speakers[0], role: "ADMIN" }],
  }).success, false);
});

test("public submission schema rejects duplicate normalized speaker emails before roster writes", () => {
  assert.equal(publicAbstractUpsertSchema.safeParse({
    ...validPublicSubmission,
    speakers: [
      validPublicSubmission.speakers[0],
      { email: " SPEAKER@EXAMPLE.TEST ", name: "Duplicate", isPrimary: false },
    ],
  }).success, false);
});

test("public submission schema bounds every attacker-controlled answer shape and speaker email", () => {
  const tooLongEmail = `${"a".repeat(245)}@example.test`;
  assert.equal(publicAbstractUpsertSchema.safeParse({
    ...validPublicSubmission,
    speakers: [{ ...validPublicSubmission.speakers[0], email: tooLongEmail }],
  }).success, false);
  assert.equal(publicAbstractUpsertSchema.safeParse({
    ...validPublicSubmission,
    answers: { ["k".repeat(121)]: "value" },
  }).success, false);
  assert.equal(publicAbstractUpsertSchema.safeParse({
    ...validPublicSubmission,
    answers: { answer: "x".repeat(8_001) },
  }).success, false);
  assert.equal(publicAbstractUpsertSchema.safeParse({
    ...validPublicSubmission,
    answers: { number: 1_000_001 },
  }).success, false);
  assert.equal(publicAbstractUpsertSchema.safeParse({
    ...validPublicSubmission,
    answers: { choices: Array.from({ length: 51 }, () => "choice") },
  }).success, false);
  assert.equal(publicAbstractUpsertSchema.safeParse({
    ...validPublicSubmission,
    answers: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`answer_${index}`, "ok"])),
  }).success, false);
});
