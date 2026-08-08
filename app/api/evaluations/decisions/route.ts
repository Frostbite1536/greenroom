import { prisma } from "@/lib/prisma";
import { abstractDecisionSchema } from "@/types/api";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { serializeAbstract } from "@/lib/api/abstract-serialize";

export const dynamic = "force-dynamic";

/**
 * POST /api/evaluations/decisions — accept or reject an abstract (admin).
 * Records `decidedAt`; conversion to a schedulable Session is a separate,
 * explicit step (`/api/evaluations/convert`) per INV-DOMAIN-001.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, abstractDecisionSchema);

  const abstract = await prisma.abstract.findUnique({ where: { id: input.abstractId } });
  if (!abstract || abstract.eventId !== ctx.eventId) {
    throw new ApiError(404, "ABSTRACT_NOT_FOUND", "Abstract not found.");
  }
  if (abstract.status === "WITHDRAWN") {
    throw new ApiError(409, "ABSTRACT_WITHDRAWN", "This abstract has been withdrawn.");
  }

  const updated = await prisma.abstract.update({
    where: { id: input.abstractId },
    data: { status: input.decision, decidedAt: new Date() },
    include: { category: true, speakers: { include: { user: true } } },
  });

  return ok(serializeAbstract(updated));
});
