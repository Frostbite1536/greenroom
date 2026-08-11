import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { classifyCategoryMutationError } from "@/lib/services/category-mutation-errors";

test("category uniqueness races have an actionable stable classification", () => {
  const duplicate = new Prisma.PrismaClientKnownRequestError("duplicate category", {
    code: "P2002",
    clientVersion: "test",
  });
  const missing = new Prisma.PrismaClientKnownRequestError("record vanished", {
    code: "P2025",
    clientVersion: "test",
  });
  assert.equal(classifyCategoryMutationError(duplicate), "CATEGORY_NAME_TAKEN");
  // A concurrent delete invalidating the scoped preflight must read the same as
  // an unknown or cross-event id, not as a 500.
  assert.equal(classifyCategoryMutationError(missing), "CATEGORY_NOT_FOUND");
  assert.equal(classifyCategoryMutationError(new Error("database offline")), null);
});
