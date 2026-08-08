import { prisma } from "@/lib/prisma";
import { reviewAssignmentInputSchema } from "@/types/api";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/** GET /api/evaluations/assignments?planId= — assignments for a plan. */
export const GET = handle(async (req) => {
  const ctx = await requireContext(["ADMIN", "EVALUATOR"]);
  const planId = new URL(req.url).searchParams.get("planId");
  if (!planId) throw new ApiError(400, "MISSING_PLAN", "planId is required.");

  const plan = await prisma.evaluationPlan.findUnique({ where: { id: planId } });
  if (!plan || plan.eventId !== ctx.eventId) {
    throw new ApiError(404, "PLAN_NOT_FOUND", "Plan not found.");
  }

  const assignments = await prisma.reviewAssignment.findMany({
    where: {
      planId,
      // Evaluators only see their own queue; admins see everything.
      ...(ctx.role === "EVALUATOR" ? { evaluatorId: ctx.userId } : {}),
    },
    include: {
      abstract: {
        include: { category: true, speakers: { include: { user: true } } },
      },
      evaluator: { select: { id: true, name: true, email: true } },
    },
    orderBy: { assignedAt: "asc" },
  });

  return ok(
    assignments.map((a) => ({
      id: a.id,
      planId: a.planId,
      abstractId: a.abstractId,
      teamKey: a.teamKey,
      status: a.status,
      evaluator: a.evaluator,
      abstract: {
        id: a.abstract.id,
        // Blind review hides speaker identity from evaluators.
        title: a.abstract.title,
        category: a.abstract.category
          ? { id: a.abstract.category.id, name: a.abstract.category.name }
          : null,
        speakers:
          plan.isBlind && ctx.role === "EVALUATOR"
            ? []
            : a.abstract.speakers.map((s) => ({
                name: s.user.name,
                isPrimary: s.isPrimary,
              })),
      },
    })),
  );
});

/**
 * POST /api/evaluations/assignments — assign abstracts to evaluators (admin).
 * When `teamKey` is omitted it defaults per-abstract from the abstract's
 * `Category.defaultTeamKey` (category-based routing). Assigned abstracts move to
 * UNDER_REVIEW. Idempotent on (plan, abstract, evaluator).
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, reviewAssignmentInputSchema);

  const plan = await prisma.evaluationPlan.findUnique({ where: { id: input.planId } });
  if (!plan || plan.eventId !== ctx.eventId) {
    throw new ApiError(404, "PLAN_NOT_FOUND", "Plan not found.");
  }

  const abstracts = await prisma.abstract.findMany({
    where: { id: { in: input.abstractIds }, eventId: ctx.eventId },
    include: { category: true },
  });
  if (abstracts.length !== input.abstractIds.length) {
    throw new ApiError(422, "INVALID_ABSTRACTS", "One or more abstracts are not in this event.");
  }

  const evaluators = await prisma.eventMember.findMany({
    where: { eventId: ctx.eventId, userId: { in: input.evaluatorIds } },
    select: { userId: true },
  });
  const validEvaluatorIds = new Set(evaluators.map((e) => e.userId));
  if (validEvaluatorIds.size !== input.evaluatorIds.length) {
    throw new ApiError(422, "INVALID_EVALUATORS", "One or more evaluators are not event members.");
  }

  const created = await prisma.$transaction(async (tx) => {
    let count = 0;
    for (const abstract of abstracts) {
      const teamKey = input.teamKey ?? abstract.category?.defaultTeamKey ?? null;
      for (const evaluatorId of input.evaluatorIds) {
        await tx.reviewAssignment.upsert({
          where: {
            planId_abstractId_evaluatorId: {
              planId: input.planId,
              abstractId: abstract.id,
              evaluatorId,
            },
          },
          update: { teamKey },
          create: { planId: input.planId, abstractId: abstract.id, evaluatorId, teamKey },
        });
        count++;
      }
      if (abstract.status === "SUBMITTED") {
        await tx.abstract.update({
          where: { id: abstract.id },
          data: { status: "UNDER_REVIEW" },
        });
      }
    }
    return count;
  });

  return ok({ assignments: created }, 201);
});
