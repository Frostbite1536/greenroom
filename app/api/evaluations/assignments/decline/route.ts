import { prisma } from "@/lib/prisma";
import { reviewAssignmentDeclineSchema } from "@/types/api";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { lockAbstractForWrite } from "@/lib/services/abstract-lock";
import { conflictDeclineRefusal } from "@/lib/review-conflict";

export const dynamic = "force-dynamic";

/**
 * POST /api/evaluations/assignments/decline — a reviewer declares a conflict of
 * interest on a proposal assigned to them (ABS-12).
 *
 * Assignment-scoped by construction: the row is resolved from the caller's own
 * session through the `(plan, abstract, evaluator)` unique key, exactly as the
 * score route resolves the assignment it writes. There is no evaluator id in
 * the body, so this path cannot address anybody else's queue, and the only
 * status it can produce is the `DECLINED` the assignment lifecycle already has.
 *
 * `ReviewScore` rows are deliberately untouched, matching the C6 withdrawal
 * decline: partial scores from a declined assignment are never aggregated,
 * because `admin-decision-summary` reads scores only from COMPLETED assignments.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["EVALUATOR", "ADMIN"]);
  const input = await parseBody(req, reviewAssignmentDeclineSchema);

  const plan = await prisma.evaluationPlan.findUnique({ where: { id: input.planId } });
  if (!plan || plan.eventId !== ctx.eventId) {
    throw new ApiError(404, "PLAN_NOT_FOUND", "Plan not found.");
  }

  // Authorization preflight only: a cross-event plan id must not reach the
  // advisory lock below. Status is re-read inside the transaction.
  const assignment = await prisma.reviewAssignment.findUnique({
    where: {
      planId_abstractId_evaluatorId: {
        planId: input.planId,
        abstractId: input.abstractId,
        evaluatorId: ctx.userId,
      },
    },
    select: { id: true },
  });
  if (!assignment) {
    throw new ApiError(403, "NOT_ASSIGNED", "You are not assigned to review this abstract.");
  }

  await prisma.$transaction(async (tx) => {
    // LOCK-ORDER-v1, in the same order the score write takes: the shared plan
    // row lock, then the per-abstract advisory lock. Holding both means a
    // concurrent score submit on this very assignment cannot interleave with
    // the status write, so the pair can never settle as COMPLETED-and-declined.
    const [lockedPlan] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "EvaluationPlan" WHERE "id" = ${input.planId} FOR SHARE
    `;
    if (!lockedPlan) {
      throw new ApiError(404, "PLAN_NOT_FOUND", "Plan not found.");
    }
    const currentPlan = await tx.evaluationPlan.findUniqueOrThrow({
      where: { id: lockedPlan.id },
      select: { eventId: true },
    });
    if (currentPlan.eventId !== ctx.eventId) {
      throw new ApiError(404, "PLAN_NOT_FOUND", "Plan not found.");
    }

    await lockAbstractForWrite(tx, input.abstractId);
    const fresh = await tx.reviewAssignment.findUnique({
      where: { id: assignment.id },
      select: { status: true, abstract: { select: { status: true } } },
    });
    if (!fresh) {
      throw new ApiError(403, "NOT_ASSIGNED", "You are not assigned to review this abstract.");
    }

    // The one shared rule: the button offers exactly what this refuses.
    const refusal = conflictDeclineRefusal(fresh.status, fresh.abstract.status === "WITHDRAWN");
    if (refusal) throw new ApiError(refusal.status, refusal.code, refusal.message);

    await tx.reviewAssignment.update({
      where: { id: assignment.id },
      data: { status: "DECLINED" },
    });
  });

  return ok({ abstractId: input.abstractId, status: "DECLINED" });
});
