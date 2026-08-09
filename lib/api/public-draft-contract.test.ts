import assert from "node:assert/strict";
import test from "node:test";
import { publicAbstractUpsertSchema, publicDraftResumeSchema } from "@/types/api";

const write = {
  formConfigId: "form-1",
  title: "A bounded public draft",
  speakers: [{ email: "speaker@example.test", name: "Speaker", isPrimary: true }],
  answers: {},
  intent: "saveDraft" as const,
};
const capability = "A".repeat(43);

test("existing anonymous public draft access fields stay broad under the bounded body parser", () => {
  assert.equal(publicAbstractUpsertSchema.safeParse({ ...write, abstractId: "draft-1" }).success, true);
  assert.equal(publicAbstractUpsertSchema.safeParse({
    ...write, abstractId: "draft-1", draftCapability: capability, expectedDraftRevision: 1,
  }).success, true);
  assert.equal(publicAbstractUpsertSchema.safeParse({ ...write, abstractId: "draft-1", draftCapability: "", expectedDraftRevision: 1 }).success, true);
  assert.equal(publicAbstractUpsertSchema.safeParse({ ...write, abstractId: "draft-1", draftCapability: "x".repeat(129), expectedDraftRevision: 1 }).success, true);
  assert.equal(publicAbstractUpsertSchema.safeParse({ ...write, abstractId: "draft-1", draftCapability: { wrong: true }, expectedDraftRevision: 1 }).success, true);
  assert.equal(publicAbstractUpsertSchema.safeParse({ ...write, abstractId: "draft-1", draftCapability: capability, expectedDraftRevision: 0 }).success, true);
});

test("public draft resume is strict and body-shaped", () => {
  assert.equal(publicDraftResumeSchema.safeParse({
    formConfigId: "form-1", abstractId: "draft-1", draftCapability: capability,
  }).success, true);
  assert.equal(publicDraftResumeSchema.safeParse({
    formConfigId: "form-1", abstractId: "draft-1", draftCapability: capability, extra: true,
  }).success, false);
  assert.equal(publicDraftResumeSchema.safeParse({
    formConfigId: "form-1", abstractId: "draft-1", draftCapability: { wrong: true },
  }).success, true);
});
