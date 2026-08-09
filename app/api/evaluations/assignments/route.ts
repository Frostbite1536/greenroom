import { prisma } from "@/lib/prisma";
import { reviewAssignmentInputSchema } from "@/types/api";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { lockAbstractForWrite } from "@/lib/services/abstract-lock";

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
      ...(ctx.role === "ADMIN"
        ? { evaluator: { select: { id: true, name: true, email: true } } }
        : {}),
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
      ...(ctx.role === "ADMIN" ? { evaluator: a.evaluator } : {}),
      abstract: {
        id: a.abstract.id,
        // Blind review hides speaker identity from evaluators.
        title: a.abstract.title,
        // Speakers can withdraw mid-review (W1); the queue needs to say so
        // rather than inviting a review that will be refused on submit.
        status: a.abstract.status,
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

  // Authorization preflight only: do not let a guessed cross-event id acquire
  // another event's advisory lock. Status is deliberately not trusted here;
  // the transaction must re-read it after taking the shared write locks.
  const scopedAbstracts = await prisma.abstract.findMany({
    where: { id: { in: input.abstractIds }, eventId: ctx.eventId },
    select: { id: true },
  });
  if (scopedAbstracts.length !== input.abstractIds.length) {
    throw new ApiError(422, "INVALID_ABSTRACTS", "One or more abstracts are not in this event.");
  }

  const created = await prisma.$transaction(async (tx) => {
    // Assignment, speaker withdrawal, scoring and decisions all observe the
    // same per-abstract serialization boundary. Stable ordering prevents two
    // multi-proposal assignment requests from deadlocking each other.
    for (const abstractId of [...input.abstractIds].sort()) {
      await lockAbstractForWrite(tx, abstractId);
    }

    // Re-read only after every lock is held. A decision or withdrawal that won
    // the race must stay terminal; assignment may never resurrect it as
    // UNDER_REVIEW or attach a new reviewer to it.
    const abstracts = await tx.abstract.findMany({
      where: { id: { in: input.abstractIds }, eventId: ctx.eventId },
      include: { category: true },
    });
    if (abstracts.length !== input.abstractIds.length) {
      throw new ApiError(422, "INVALID_ABSTRACTS", "One or more abstracts are not in this event.");
    }
    const unreviewable = abstracts.find(
      (abstract) => abstract.status !== "SUBMITTED" && abstract.status !== "UNDER_REVIEW",
    );
    if (unreviewable) {
      throw new ApiError(
        409,
        "ABSTRACT_NOT_REVIEWABLE",
        "Only submitted or under-review proposals can be assigned. Refresh and choose a reviewable proposal.",
      );
    }

    // Event membership alone is insufficient: speakers and operators must not
    // become reviewers through a forged user id. Admins may review alongside
    // evaluators, matching the existing queue and setup read contracts.
    const evaluators = await tx.eventMember.findMany({
      where: {
        eventId: ctx.eventId,
        userId: { in: input.evaluatorIds },
        role: { in: ["EVALUATOR", "ADMIN"] },
      },
      select: { userId: true },
    });
    const validEvaluatorIds = new Set(evaluators.map((evaluator) => evaluator.userId));
    if (validEvaluatorIds.size !== input.evaluatorIds.length) {
      throw new ApiError(
        422,
        "INVALID_EVALUATORS",
        "Every reviewer must be an evaluator or admin for this event.",
      );
    }

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
