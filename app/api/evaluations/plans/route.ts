import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { evaluationPlanInputSchema } from "@/types/api";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { requireEventOwnedRow } from "@/lib/services/event-owned-row";
import { overallReviewCommentKeyChanged } from "@/lib/services/review-score-comment";
import { rubricWeightBoundErrors } from "@/lib/rubric-weight";

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

  const data = {
    name: input.name,
    ordinal: input.ordinal,
    isBlind: input.isBlind,
    startsAt: input.startsAt ? new Date(input.startsAt) : null,
    endsAt: input.endsAt ? new Date(input.endsAt) : null,
    rubric: input.rubric as unknown as Prisma.InputJsonValue,
  };

  /**
   * The `RUBRIC_WEIGHT_MAX` ceiling lives here rather than in
   * `rubricCriterionSchema` because it is a rule about the *edit*, not the
   * *value*: a weight merely carried forward from an older plan is legitimate,
   * while a new or changed one must meet the ceiling. Zod cannot express that —
   * it never sees the stored rubric. See `rubricWeightBoundErrors`.
   *
   * A creation has nothing to carry forward, so it is checked here against no
   * stored rubric and every over-limit weight is refused. An update is checked
   * inside the transaction below, against the row it is about to overwrite.
   */
  const refuseWeights = (storedRubric: unknown) => {
    const fieldErrors = rubricWeightBoundErrors(input.rubric, storedRubric);
    if (fieldErrors) {
      throw new ApiError(422, "VALIDATION_ERROR", "Request validation failed.", fieldErrors);
    }
  };
  if (!input.id) refuseWeights(null);

  try {
    const plan = input.id
      ? await prisma.$transaction(async (tx) => {
          // The row lock keeps the verified event ownership current until the
          // update commits, rather than trusting the request body eventId.
          const [existing] = await tx.$queryRaw<{ id: string; eventId: string; rubric: unknown }[]>`
            SELECT "id", "eventId", "rubric" FROM "EvaluationPlan" WHERE "id" = ${input.id} FOR UPDATE
          `;
          const owned = requireEventOwnedRow(existing, ctx.eventId, "PLAN_NOT_FOUND", "Plan");
          // Compared against the row just read FOR UPDATE, so the "unchanged"
          // exception is decided from server state that cannot move before the
          // write commits — never from a client claim that a weight is legacy.
          refuseWeights(owned.rubric);
          if (overallReviewCommentKeyChanged(owned.rubric, input.rubric)) {
            const comment = await tx.reviewScore.findFirst({
              where: { planId: owned.id, comment: { not: null } },
              select: { id: true },
            });
            if (comment) {
              throw new ApiError(
                409,
                "REVIEW_COMMENT_KEY_IN_USE",
                "Keep the first rubric criterion while written reviewer feedback exists, or clear that feedback before reordering it.",
                { rubric: ["The first criterion stores overall reviewer feedback and cannot change yet."] },
              );
            }
          }
          return tx.evaluationPlan.update({ where: { id: owned.id }, data });
        })
      : await prisma.evaluationPlan.create({ data: { eventId: ctx.eventId, ...data } });
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
