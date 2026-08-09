import assert from "node:assert/strict";
import test from "node:test";
import {
  Prisma,
  type Abstract,
  type Category,
  type FormConfig,
  type FormField,
  type ReviewAssignment,
  type ReviewScore,
} from "@prisma/client";
import { serializeAbstract, serializeAdminAbstract } from "@/lib/api/abstract-serialize";
import { serializePublicForm } from "@/lib/api/form-serialize";

test("serializePublicForm includes event categories in supplied stable order", () => {
  const form = {
    id: "form-1",
    eventId: "event-1",
    name: "CFP",
    slug: "cfp",
    welcomeText: null,
    thankYouText: null,
    opensAt: null,
    closesAt: null,
    submissionLimit: null,
    minSpeakers: 1,
    maxSpeakers: 2,
    maxBioLength: 500,
    published: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    fields: [] as FormField[],
    event: {
      categories: [
        { id: "category-2", eventId: "event-1", name: "Backend", description: null, defaultTeamKey: null, sortOrder: 1, createdAt: new Date(), updatedAt: new Date() },
        { id: "category-1", eventId: "event-1", name: "AI", description: null, defaultTeamKey: null, sortOrder: 0, createdAt: new Date(), updatedAt: new Date() },
      ] as Category[],
    },
  } satisfies FormConfig & { fields: FormField[]; event: { categories: Category[] } };

  assert.deepEqual(serializePublicForm(form).categories, [
    { id: "category-2", name: "Backend" },
    { id: "category-1", name: "AI" },
  ]);
});

test("serializeAbstract derives review progress and an average score from included relations", () => {
  const abstract = {
    id: "abstract-1",
    eventId: "event-1",
    formConfigId: "form-1",
    submitterId: "user-1",
    title: "A proposal",
    abstract: null,
    format: null,
    durationMinutes: null,
    categoryId: null,
    status: "UNDER_REVIEW",
    submittedAt: null,
    decidedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    reviewAssignments: [
      { status: "COMPLETED" },
      { status: "IN_PROGRESS" },
    ] as Pick<ReviewAssignment, "status">[],
    reviewScores: [
      { score: new Prisma.Decimal(4) },
      { score: new Prisma.Decimal(5) },
      { score: new Prisma.Decimal(3) },
    ] as Pick<ReviewScore, "score">[],
  } satisfies Abstract & {
    reviewAssignments: Pick<ReviewAssignment, "status">[];
    reviewScores: Pick<ReviewScore, "score">[];
  };

  const result = serializeAbstract(abstract);
  assert.equal(result.reviewsComplete, 1);
  assert.equal(result.reviewsTotal, 2);
  assert.equal(result.avgScore, 4);
});

test("serializeAbstract preserves the non-final MAYBE state and its null final-decision timestamp", () => {
  const abstract = {
    id: "abstract-maybe",
    eventId: "event-1",
    formConfigId: "form-1",
    submitterId: "user-1",
    title: "A proposal on hold",
    abstract: null,
    format: null,
    durationMinutes: null,
    categoryId: null,
    status: "MAYBE",
    submittedAt: new Date("2026-08-01T00:00:00.000Z"),
    decidedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } satisfies Abstract;

  const result = serializeAbstract(abstract);
  assert.equal(result.status, "MAYBE");
  assert.equal(result.decidedAt, null);
});

test("serializeAdminAbstract omits legacy cross-round score and progress fields", () => {
  const abstract = {
    id: "abstract-1",
    eventId: "event-1",
    formConfigId: "form-1",
    submitterId: "user-1",
    title: "A proposal",
    abstract: null,
    format: null,
    durationMinutes: null,
    categoryId: null,
    status: "UNDER_REVIEW",
    submittedAt: null,
    decidedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    reviewAssignments: [{ status: "COMPLETED" }] as Pick<ReviewAssignment, "status">[],
    reviewScores: [{ score: new Prisma.Decimal(4) }] as Pick<ReviewScore, "score">[],
  } satisfies Abstract & {
    reviewAssignments: Pick<ReviewAssignment, "status">[];
    reviewScores: Pick<ReviewScore, "score">[];
  };

  const result = serializeAdminAbstract(abstract);
  assert.equal("avgScore" in result, false);
  assert.equal("reviewsComplete" in result, false);
  assert.equal("reviewsTotal" in result, false);
});
