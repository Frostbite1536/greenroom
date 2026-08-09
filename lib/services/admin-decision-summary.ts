import { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api/http";
import { assertEventQueryBound, OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import type { ApiContext } from "@/lib/api/context";
import { prisma } from "@/lib/prisma";
import { rubricCriterionSchema } from "@/types/api";

/** A deliberately small plan projection: decision reads never expose reviewers. */
export type AdminDecisionPlan = {
  id: string;
  name: string;
  ordinal: number;
};

export type AdminDecisionAbstractSummary = {
  completedAssignments: number;
  includedReviews: number;
  weightedAverage: number | null;
};

export type AdminDecisionSummary = {
  plans: AdminDecisionPlan[];
  selectedPlan: AdminDecisionPlan | null;
  selectionRequired: boolean;
  summariesByAbstractId: Record<string, AdminDecisionAbstractSummary>;
};

export type AdminDecisionSummaryInput = {
  /** Already materialized, event-scoped parent ids; this service never broad-scans abstracts. */
  abstractIds: readonly string[];
  planId?: string | null;
};

export type DecisionRubricCriterion = {
  key: string;
  min: number;
  max: number;
  weight: number;
};

type CompletedAssignment = {
  abstractId: string;
  evaluatorId: string;
};

type DecisionScore = {
  abstractId: string;
  evaluatorId: string;
  rubricKey: string;
  score: unknown;
};

const planTake = OPERATOR_QUERY_LIMITS.adminDecisionPlans + 1;
const assignmentTake = OPERATOR_QUERY_LIMITS.adminDecisionAssignments + 1;
const scoreTake = OPERATOR_QUERY_LIMITS.adminDecisionScores + 1;

function emptySummary(): AdminDecisionAbstractSummary {
  return { completedAssignments: 0, includedReviews: 0, weightedAverage: null };
}

function emptySummaries(abstractIds: readonly string[]): Record<string, AdminDecisionAbstractSummary> {
  return Object.fromEntries(abstractIds.map((abstractId) => [abstractId, emptySummary()]));
}

/**
 * Parse a persisted rubric strictly for an organizer decision summary. Existing
 * write compatibility remains in `rubric.ts`; malformed legacy plans simply
 * contribute no numeric reviews instead of producing a misleading average.
 */
export function parseDecisionRubric(raw: unknown): DecisionRubricCriterion[] | null {
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > OPERATOR_QUERY_LIMITS.adminDecisionRubricCriteria
  ) {
    return null;
  }

  const seenKeys = new Set<string>();
  const rubric: DecisionRubricCriterion[] = [];
  for (const item of raw) {
    const parsed = rubricCriterionSchema.safeParse(item);
    if (!parsed.success || seenKeys.has(parsed.data.key)) return null;
    seenKeys.add(parsed.data.key);
    rubric.push({
      key: parsed.data.key,
      min: parsed.data.min,
      max: parsed.data.max,
      weight: parsed.data.weight,
    });
  }
  return rubric;
}

/** Resolve the explicit-round policy without a highest-ordinal fallback. */
export function resolveAdminDecisionPlan(
  plans: readonly AdminDecisionPlan[],
  requestedPlanId?: string | null,
): Pick<AdminDecisionSummary, "selectedPlan" | "selectionRequired"> {
  const planId = requestedPlanId?.trim() || null;
  if (planId) {
    const selectedPlan = plans.find((plan) => plan.id === planId);
    if (!selectedPlan) throw new ApiError(404, "PLAN_NOT_FOUND", "Plan not found.");
    return { selectedPlan, selectionRequired: false };
  }
  if (plans.length === 1) return { selectedPlan: plans[0], selectionRequired: false };
  return { selectedPlan: null, selectionRequired: plans.length > 1 };
}

/**
 * Fail closed per completed assignment. A reviewer contributes only when the
 * current rubric is valid and they have exactly one finite, in-range score for
 * every criterion (and no foreign/duplicate keys).
 */
export function summarizeCompletedDecisionReviews(args: {
  abstractIds: readonly string[];
  rubric: DecisionRubricCriterion[] | null;
  assignments: readonly CompletedAssignment[];
  scores: readonly DecisionScore[];
}): Record<string, AdminDecisionAbstractSummary> {
  const abstractIds = [...new Set(args.abstractIds)];
  const summaries = emptySummaries(abstractIds);
  const permittedAbstractIds = new Set(abstractIds);
  const scoresByAbstract = new Map<string, Map<string, DecisionScore[]>>();

  for (const score of args.scores) {
    if (!permittedAbstractIds.has(score.abstractId)) continue;
    let byEvaluator = scoresByAbstract.get(score.abstractId);
    if (!byEvaluator) {
      byEvaluator = new Map();
      scoresByAbstract.set(score.abstractId, byEvaluator);
    }
    const evaluatorScores = byEvaluator.get(score.evaluatorId) ?? [];
    evaluatorScores.push(score);
    byEvaluator.set(score.evaluatorId, evaluatorScores);
  }

  const weightedByAbstract = new Map<string, number[]>();
  for (const assignment of args.assignments) {
    const summary = summaries[assignment.abstractId];
    if (!summary) continue;
    summary.completedAssignments++;
    if (!args.rubric) continue;

    const scores = scoresByAbstract.get(assignment.abstractId)?.get(assignment.evaluatorId) ?? [];
    const scoresByKey = new Map<string, number>();
    let valid = scores.length === args.rubric.length;
    for (const score of scores) {
      const criterion = args.rubric.find((candidate) => candidate.key === score.rubricKey);
      const value = Number(score.score);
      if (
        !criterion ||
        scoresByKey.has(score.rubricKey) ||
        !Number.isFinite(value) ||
        value < criterion.min ||
        value > criterion.max
      ) {
        valid = false;
        break;
      }
      scoresByKey.set(score.rubricKey, value);
    }
    if (!valid || scoresByKey.size !== args.rubric.length) continue;

    let numerator = 0;
    let denominator = 0;
    for (const criterion of args.rubric) {
      const score = scoresByKey.get(criterion.key);
      if (score === undefined) {
        valid = false;
        break;
      }
      numerator += score * criterion.weight;
      denominator += criterion.weight;
    }
    if (!valid || !Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) continue;

    summary.includedReviews++;
    const values = weightedByAbstract.get(assignment.abstractId) ?? [];
    values.push(numerator / denominator);
    weightedByAbstract.set(assignment.abstractId, values);
  }

  for (const [abstractId, values] of weightedByAbstract) {
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    summaries[abstractId].weightedAverage = Number.isFinite(average) ? average : null;
  }
  return summaries;
}

/**
 * Admin-only, event-scoped decision summary for already bounded abstract IDs.
 * Every dependent read shares one RepeatableRead snapshot so the selected plan,
 * completed assignments, and score rows cannot disagree during a live review.
 */
export async function getAdminDecisionSummary(
  ctx: Pick<ApiContext, "eventId" | "role">,
  input: AdminDecisionSummaryInput,
): Promise<AdminDecisionSummary> {
  if (ctx.role !== "ADMIN") {
    throw new ApiError(403, "FORBIDDEN", "You do not have access to this resource.");
  }

  const abstractIds = [...new Set(input.abstractIds)];
  assertEventQueryBound(
    abstractIds,
    OPERATOR_QUERY_LIMITS.adminDecisionAbstracts,
    "decision-summary abstracts",
  );

  return prisma.$transaction(async (tx) => {
    const plans = await tx.evaluationPlan.findMany({
      where: { eventId: ctx.eventId },
      // Keep event plan enumeration metadata-only. The selected plan's rubric
      // is read below inside this same snapshot, avoiding unrelated JSON blobs.
      select: { id: true, name: true, ordinal: true },
      orderBy: [{ ordinal: "asc" }, { id: "asc" }],
      take: planTake,
    });
    assertEventQueryBound(plans, OPERATOR_QUERY_LIMITS.adminDecisionPlans, "evaluation plans");

    const planOptions = plans.map(({ id, name, ordinal }) => ({ id, name, ordinal }));
    const { selectedPlan, selectionRequired } = resolveAdminDecisionPlan(planOptions, input.planId);
    const base = {
      plans: planOptions,
      selectedPlan,
      selectionRequired,
      summariesByAbstractId: emptySummaries(abstractIds),
    };
    if (!selectedPlan || abstractIds.length === 0) return base;

    const selected = await tx.evaluationPlan.findFirst({
      where: { id: selectedPlan.id, eventId: ctx.eventId },
      select: { rubric: true },
    });
    if (!selected) throw new ApiError(404, "PLAN_NOT_FOUND", "Plan not found.");
    const assignments = await tx.reviewAssignment.findMany({
      where: {
        planId: selectedPlan.id,
        abstractId: { in: abstractIds },
        status: "COMPLETED",
      },
      select: { abstractId: true, evaluatorId: true },
      orderBy: [{ abstractId: "asc" }, { evaluatorId: "asc" }, { id: "asc" }],
      take: assignmentTake,
    });
    assertEventQueryBound(
      assignments,
      OPERATOR_QUERY_LIMITS.adminDecisionAssignments,
      "completed review assignments",
    );

    const evaluatorIds = [...new Set(assignments.map((assignment) => assignment.evaluatorId))];
    const scores = evaluatorIds.length === 0
      ? []
      : await tx.reviewScore.findMany({
          where: {
            planId: selectedPlan.id,
            abstractId: { in: abstractIds },
            evaluatorId: { in: evaluatorIds },
          },
          select: { abstractId: true, evaluatorId: true, rubricKey: true, score: true },
          orderBy: [
            { abstractId: "asc" },
            { evaluatorId: "asc" },
            { rubricKey: "asc" },
            { id: "asc" },
          ],
          take: scoreTake,
        });
    assertEventQueryBound(scores, OPERATOR_QUERY_LIMITS.adminDecisionScores, "review scores");

    return {
      ...base,
      summariesByAbstractId: summarizeCompletedDecisionReviews({
        abstractIds,
        rubric: parseDecisionRubric(selected.rubric),
        assignments,
        scores,
      }),
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
