import { prisma } from "@/lib/prisma";
import { categoryInputSchema, categoryUpdateSchema } from "@/types/api";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { requireEventOwnedRow } from "@/lib/services/event-owned-row";
import { decideCategoryDeletion } from "@/lib/services/category-deletion";
import { classifyCategoryMutationError } from "@/lib/services/category-mutation-errors";

export const dynamic = "force-dynamic";

/** The stable duplicate-name refusal, shared by every category writer here. */
function categoryNameTakenError(): ApiError {
  return new ApiError(409, "CATEGORY_NAME_TAKEN", "Another category in this event already uses that name.", {
    name: ["This category name is already in use."],
  });
}

/** GET /api/cfp/categories — categories for the event (drives review routing). */
export const GET = handle(async () => {
  const ctx = await requireContext(["ADMIN", "EVALUATOR"]);
  const categories = await prisma.category.findMany({
    where: { eventId: ctx.eventId },
    orderBy: { sortOrder: "asc" },
  });
  return ok(categories);
});

/** POST /api/cfp/categories — create or update a category (admin). */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, categoryInputSchema);

  const data = {
    name: input.name,
    description: input.description ?? null,
    defaultTeamKey: input.defaultTeamKey ?? null,
    sortOrder: input.sortOrder,
  };
  let category;
  try {
    category = input.id
      ? await prisma.$transaction(async (tx) => {
          // Lock and authorize the stored row, not the caller-controlled body
          // eventId. This holds the ownership check through the following write.
          const [existing] = await tx.$queryRaw<{ id: string; eventId: string }[]>`
            SELECT "id", "eventId" FROM "Category" WHERE "id" = ${input.id} FOR UPDATE
          `;
          const owned = requireEventOwnedRow(existing, ctx.eventId, "CATEGORY_NOT_FOUND", "Category");
          return tx.category.update({ where: { id: owned.id }, data });
        })
      : await prisma.category.create({ data: { eventId: ctx.eventId, ...data } });
  } catch (error) {
    const mutationError = classifyCategoryMutationError(error);
    if (mutationError === "CATEGORY_NAME_TAKEN") throw categoryNameTakenError();
    // The scoped preflight may be invalidated by a concurrent delete. Keep that
    // race indistinguishable from an unknown or cross-event category ID.
    if (mutationError === "CATEGORY_NOT_FOUND") {
      throw new ApiError(404, "CATEGORY_NOT_FOUND", "Category not found.");
    }
    throw error;
  }
  return ok(category, input.id ? 200 : 201);
});

/**
 * PATCH /api/cfp/categories — edit a category only after active-event scope check.
 *
 * Separate from the whole-row POST on purpose. POST rewrites `description`,
 * `defaultTeamKey` and `sortOrder` from the body on every update, so a rename
 * sent through it clears the `defaultTeamKey` that routes this category's
 * proposals to a review team. This handler applies only the fields the operator
 * actually supplied, which is what makes renaming safe.
 */
export const PATCH = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, categoryUpdateSchema);

  try {
    const category = await prisma.$transaction(async (tx) => {
      // Read the stored event under the same exclusive lock as the write. A
      // caller-controlled category id can never authorize a cross-event update.
      const [existing] = await tx.$queryRaw<{ id: string; eventId: string }[]>`
        SELECT "id", "eventId" FROM "Category" WHERE "id" = ${input.id} FOR UPDATE
      `;
      const owned = requireEventOwnedRow(existing, ctx.eventId, "CATEGORY_NOT_FOUND", "Category");
      return tx.category.update({
        where: { id: owned.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.defaultTeamKey !== undefined ? { defaultTeamKey: input.defaultTeamKey } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        },
      });
    });
    return ok(category);
  } catch (error) {
    const mutationError = classifyCategoryMutationError(error);
    if (mutationError === "CATEGORY_NAME_TAKEN") throw categoryNameTakenError();
    if (mutationError === "CATEGORY_NOT_FOUND") {
      throw new ApiError(404, "CATEGORY_NOT_FOUND", "Category not found.");
    }
    throw error;
  }
});

/**
 * DELETE /api/cfp/categories?categoryId= — remove a category nothing references.
 *
 * Both references are `onDelete: SetNull`, so the failure mode is silence: an
 * unchecked delete would strip the review routing off every proposal in this
 * category and the topic off every talk on the programme, naming none of them.
 * Locking and re-reading the scoped Category before the usage reads keeps that
 * unreachable — a concurrent write that adopts this category takes the FK
 * key-share lock and waits for this transaction, which then either refuses or
 * deletes. `decideCategoryDeletion` owns the refusal so the policy stays
 * testable and names the obstruction it found.
 */
export const DELETE = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const categoryId = new URL(req.url).searchParams.get("categoryId");
  if (!categoryId) throw new ApiError(400, "MISSING_CATEGORY", "categoryId is required.");

  const category = await prisma.$transaction(async (tx) => {
    // Scope is part of the locked query: cross-event and unknown IDs produce
    // the same result and never reveal whether another event owns the row.
    const [lockedCategory] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id"
      FROM "Category"
      WHERE "id" = ${categoryId} AND "eventId" = ${ctx.eventId}
      FOR UPDATE
    `;
    if (!lockedCategory) throw new ApiError(404, "CATEGORY_NOT_FOUND", "Category not found.");

    const [abstract, session] = await Promise.all([
      tx.abstract.findFirst({ where: { categoryId: lockedCategory.id }, select: { id: true } }),
      tx.session.findFirst({ where: { categoryId: lockedCategory.id }, select: { id: true } }),
    ]);
    const decision = decideCategoryDeletion({ hasAbstract: !!abstract, hasSession: !!session });
    if (!decision.allowed) {
      throw new ApiError(409, decision.code, decision.message, {
        categoryId: ["Proposals and sessions keep the category they were filed under."],
      });
    }

    return tx.category.delete({ where: { id: lockedCategory.id } });
  });

  return ok(category);
});
