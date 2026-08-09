import { prisma } from "@/lib/prisma";
import { categoryInputSchema } from "@/types/api";
import { requireContext } from "@/lib/api/context";
import { handle, ok, parseBody } from "@/lib/api/http";
import { requireEventOwnedRow } from "@/lib/services/event-owned-row";

export const dynamic = "force-dynamic";

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
  const category = input.id
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
  return ok(category, input.id ? 200 : 201);
});
