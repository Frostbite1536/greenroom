import { prisma } from "@/lib/prisma";
import { reviewScoreInputSchema } from "@/types/api";
import { requireContext } from "@/lib/api/context";
import { ApiError, fail, handle, ok, parseBody } from "@/lib/api/http";
import { parseRubric, validateScores } from "@/lib/services/rubric";
import { lockAbstractForWrite } from "@/lib/services/abstract-lock";
import {
  resolveOverallReviewComment,
  reviewScoreCreateData,
  reviewScoreUpdateData,
} from "@/lib/services/review-score-comment";

export const dynamic = "force-dynamic";

/**
 * POST /api/evaluations/scores — record an evaluator's scores for one abstract
 * against a plan rubric (evaluator/admin). Every score must reference a rubric
 * key in the plan and fall within that criterion's range (INV-EVAL-001).
 * Scores are upserted per rubric key; `complete` marks the assignment done.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["EVALUATOR", "ADMIN"]);
  const input = await parseBody(req, reviewScoreInputSchema);

  const plan = await prisma.evaluationPlan.findUnique({ where: { id: input.planId } });
  if (!plan || plan.eventId !== ctx.eventId) {
    throw new ApiError(404, "PLAN_NOT_FOUND", "Plan not found.");
  }

  const assignment = await prisma.reviewAssignment.findUnique({
    where: {
      planId_abstractId_evaluatorId: {
        planId: input.planId,
        abstractId: input.abstractId,
        evaluatorId: ctx.userId,
      },
    },
    include: { abstract: { select: { status: true } } },
  });
  if (!assignment) {
    throw new ApiError(403, "NOT_ASSIGNED", "You are not assigned to review this abstract.");
  }
  // Speakers can withdraw mid-review (W1), so scoring must stop at that point
  // rather than recording an opinion on a proposal that no longer stands.
  if (assignment.abstract.status === "WITHDRAWN") {
    throw new ApiError(
      409,
      "ABSTRACT_WITHDRAWN",
      "The speaker withdrew this proposal, so it no longer needs a review.",
    );
  }

  const rubric = parseRubric(plan.rubric);
  const validationError = validateScores(rubric, input.scores);
  if (validationError) {
    return fail(422, validationError.code, validationError.message, validationError.fieldErrors);
  }
  const overallComment = resolveOverallReviewComment(
    input.scores,
    rubric.map((criterion) => criterion.key),
  );

  await prisma.$transaction(async (tx) => {
    // Same per-abstract advisory lock as withdraw/decisions/convert: the
    // pre-transaction WITHDRAWN check can go stale against a concurrent
    // withdrawal, so re-check under the lock before persisting scores.
    await lockAbstractForWrite(tx, input.abstractId);
    const fresh = await tx.abstract.findUniqueOrThrow({
      where: { id: input.abstractId },
      select: { status: true },
    });
    if (fresh.status === "WITHDRAWN") {
      throw new ApiError(
        409,
        "ABSTRACT_WITHDRAWN",
        "The speaker withdrew this proposal, so it no longer needs a review.",
      );
    }
    if (overallComment) {
      // Normalize a deliberate replacement or clear across every stored
      // criterion before writing the one canonical overall comment below.
      await tx.reviewScore.updateMany({
        where: {
          planId: input.planId,
          abstractId: input.abstractId,
          evaluatorId: ctx.userId,
        },
        data: { comment: null },
      });
    }
    for (const entry of input.scores) {
      const comment = overallComment?.rubricKey === entry.rubricKey
        ? overallComment.comment
        : undefined;
      await tx.reviewScore.upsert({
        where: {
          planId_abstractId_evaluatorId_rubricKey: {
            planId: input.planId,
            abstractId: input.abstractId,
            evaluatorId: ctx.userId,
            rubricKey: entry.rubricKey,
          },
        },
        update: reviewScoreUpdateData({ score: entry.score, comment }),
        create: {
          planId: input.planId,
          abstractId: input.abstractId,
          evaluatorId: ctx.userId,
          rubricKey: entry.rubricKey,
          ...reviewScoreCreateData({ score: entry.score, comment }),
        },
      });
    }

    await tx.reviewAssignment.update({
      where: { id: assignment.id },
      data: input.complete
        ? { status: "COMPLETED", completedAt: new Date() }
        : { status: "IN_PROGRESS" },
    });
  });

  return ok({ abstractId: input.abstractId, complete: input.complete });
});
