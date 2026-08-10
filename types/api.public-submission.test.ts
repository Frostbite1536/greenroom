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
  // `role` is now a real speaker field, so strictness is proven with a key that
  // genuinely is not one. An authority-shaped value in it is just a label.
  assert.equal(publicAbstractUpsertSchema.safeParse({
    ...validPublicSubmission,
    speakers: [{ ...validPublicSubmission.speakers[0], userRole: "ADMIN" }],
  }).success, false);
});

test("a speaker's role is an optional bounded label that never confers authority", () => {
  const parse = (role: unknown) => publicAbstractUpsertSchema.safeParse({
    ...validPublicSubmission,
    speakers: [{ ...validPublicSubmission.speakers[0], role }],
  });

  const stated = parse("  Co-presenter  ");
  assert.equal(stated.success, true);
  assert.equal(stated.success && stated.data.speakers[0].role, "Co-presenter");

  // Blank and absent are the same honest absence, never an empty label.
  assert.equal(parse("   ").success && parse("   ").data?.speakers[0].role, null);
  assert.equal(
    publicAbstractUpsertSchema.safeParse(validPublicSubmission).data?.speakers[0].role,
    null,
  );

  // Bounded: it renders on a public speaker list.
  assert.equal(parse("x".repeat(81)).success, false);
  assert.equal(parse("x".repeat(80)).success, true);

  // A role is a label on a proposal, not a membership role: it is written to
  // AbstractSpeaker.role and reaches nothing that decides what anyone may do.
  const authorityShaped = parse("ADMIN");
  assert.equal(authorityShaped.success, true);
  assert.equal(authorityShaped.success && authorityShaped.data.speakers[0].role, "ADMIN");
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
