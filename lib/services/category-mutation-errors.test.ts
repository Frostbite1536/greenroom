import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { classifyCategoryMutationError } from "@/lib/services/category-mutation-errors";

test("category uniqueness races have an actionable stable classification", () => {
  const duplicate = new Prisma.PrismaClientKnownRequestError("duplicate category", {
    code: "P2002",
    clientVersion: "test",
  });
  assert.equal(classifyCategoryMutationError(duplicate), "CATEGORY_NAME_TAKEN");
  assert.equal(classifyCategoryMutationError(new Error("database offline")), null);
});
