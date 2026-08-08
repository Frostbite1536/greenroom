import { prisma } from "@/lib/prisma";
import { categoryInputSchema } from "@/types/api";
import { assertEventScope, requireContext } from "@/lib/api/context";
import { handle, ok, parseBody } from "@/lib/api/http";

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
  assertEventScope(ctx, input.eventId);

  const data = {
    name: input.name,
    description: input.description ?? null,
    defaultTeamKey: input.defaultTeamKey ?? null,
    sortOrder: input.sortOrder,
  };
  const category = await prisma.category.upsert({
    where: { id: input.id ?? "__new__" },
    update: data,
    create: { eventId: input.eventId, ...data },
  });
  return ok(category, input.id ? 200 : 201);
});
