import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { evaluationPlanInputSchema } from "@/types/api";
import { assertEventScope, requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/** GET /api/evaluations/plans — evaluation plans (rounds) for the event. */
export const GET = handle(async () => {
  const ctx = await requireContext(["ADMIN", "EVALUATOR"]);
  const plans = await prisma.evaluationPlan.findMany({
    where: { eventId: ctx.eventId },
    include: { _count: { select: { assignments: true, scores: true } } },
    orderBy: { ordinal: "asc" },
  });
  return ok(
    plans.map((p) => ({
      id: p.id,
      eventId: p.eventId,
      name: p.name,
      ordinal: p.ordinal,
      isBlind: p.isBlind,
      startsAt: p.startsAt?.toISOString() ?? null,
      endsAt: p.endsAt?.toISOString() ?? null,
      rubric: p.rubric,
      assignmentCount: p._count.assignments,
      scoreCount: p._count.scores,
    })),
  );
});

/**
 * POST /api/evaluations/plans — create or update a plan + rubric (admin).
 * `ordinal` is the round number; it is unique per event.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, evaluationPlanInputSchema);
  assertEventScope(ctx, input.eventId);

  const data = {
    name: input.name,
    ordinal: input.ordinal,
    isBlind: input.isBlind,
    startsAt: input.startsAt ? new Date(input.startsAt) : null,
    endsAt: input.endsAt ? new Date(input.endsAt) : null,
    rubric: input.rubric as unknown as Prisma.InputJsonValue,
  };

  try {
    const plan = await prisma.evaluationPlan.upsert({
      where: { id: input.id ?? "__new__" },
      update: data,
      create: { eventId: input.eventId, ...data },
    });
    return ok(plan, input.id ? 200 : 201);
  } catch (error) {
    if (
      typeof error === "object" &&
      error &&
      (error as { code?: string }).code === "P2002"
    ) {
      throw new ApiError(409, "ORDINAL_TAKEN", `Round ${input.ordinal} already exists.`);
    }
    throw error;
  }
});
