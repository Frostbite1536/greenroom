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

/**
 * One rubric criterion, as it contributed to this proposal's decision score.
 *
 * Aggregate, never per-evaluator. The organizer surfaces around this service
 * are deliberately identity-free — `OrganizerReviewComment` already strips
 * reviewer names, and a blind round hides them from the reviewer's own queue —
 * so a per-reviewer column here would re-introduce, on the decision screen,
 * exactly what blind review exists to remove. What an organizer needs in order
 * to read a total is which criterion earned it, not who said what.
 *
 * `average` counts only the reviews that were *included* in `weightedAverage`,
 * so the breakdown and the total can never describe different review sets.
 */
export type AdminDecisionCriterionSummary = {
  key: string;
  label: string;
  weight: number;
  min: number;
  max: number;
  /** Mean score across the included reviews; null when none contributed. */
  average: number | null;
  /** How many included reviews carried this criterion. */
  reviews: number;
};

export type AdminDecisionAbstractSummary = {
  completedAssignments: number;
  includedReviews: number;
  weightedAverage: number | null;
  /**
   * The round's criteria in stored order, each with this proposal's aggregate.
   * Empty when the round's rubric is unreadable (the same condition that
   * blanks `weightedAverage`) or when no round is selected.
   */
  criteria: AdminDecisionCriterionSummary[];
};

export type AdminDecisionSummary = {
  plans: AdminDecisionPlan[];
  /** Null only when the event has no evaluation plan at all. */
  selectedPlan: AdminDecisionPlan | null;
  summariesByAbstractId: Record<string, AdminDecisionAbstractSummary>;
  /**
   * B3 — true when a round IS selected but its stored rubric would not parse.
   *
   * `parseDecisionRubric` fails closed for the whole rubric on any malformed
   * criterion, which correctly stops a misleading average from being computed.
   * What it could not do is say so: every proposal on the board came back with
   * `weightedAverage: null` and `criteria: []`, which is character-identical to
   * the ordinary "nobody has reviewed these yet" state. An organizer reading
   * the decision board had no way to tell a round nobody had scored from a
   * round whose rubric is broken — and the second one is a data problem only
   * they can fix.
   *
   * Deliberately a boolean and not the parse error: the rubric is operator
   * input and its contents do not belong in a response body.
   */
  rubricUnreadable: boolean;
};

export type AdminDecisionSummaryInput = {
  /** Already materialized, event-scoped parent ids; this service never broad-scans abstracts. */
  abstractIds: readonly string[];
  planId?: string | null;
};

export type DecisionRubricCriterion = {
  key: string;
  /** Carried so the organizer breakdown can name the criterion it scores. */
  label: string;
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

/**
 * `rubric` seeds the criterion rows so a proposal with no included review still
 * shows *what* it will be scored against, rather than an empty section that
 * reads as "this round has no rubric". A null rubric yields no rows, matching
 * the null `weightedAverage` it also produces.
 */
function emptySummary(rubric?: DecisionRubricCriterion[] | null): AdminDecisionAbstractSummary {
  return {
    completedAssignments: 0,
    includedReviews: 0,
    weightedAverage: null,
    criteria: (rubric ?? []).map((criterion) => ({
      key: criterion.key,
      label: criterion.label,
      weight: criterion.weight,
      min: criterion.min,
      max: criterion.max,
      average: null,
      reviews: 0,
    })),
  };
}

function emptySummaries(
  abstractIds: readonly string[],
  rubric?: DecisionRubricCriterion[] | null,
): Record<string, AdminDecisionAbstractSummary> {
  return Object.fromEntries(abstractIds.map((abstractId) => [abstractId, emptySummary(rubric)]));
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
      label: parsed.data.label,
      min: parsed.data.min,
      max: parsed.data.max,
      weight: parsed.data.weight,
    });
  }
  return rubric;
}

/**
 * Resolve which round the decision columns aggregate.
 *
 * Requiring an explicit choice whenever an event had several rounds left the
 * reviews and score columns rendering inert "Choose a round" placeholders on
 * arrival, which is how a judged run reads them: as missing aggregates. The
 * default is now the newest round, so the columns are populated without setup,
 * while the selector stays fully functional and keeps its choice in the URL.
 * An explicit request always wins; an unknown id is still a 404, never a
 * silent fall back to the default.
 *
 * Selection alone changes here — which completed reviews contribute to a round
 * is unchanged and stays in `summarizeCompletedDecisionReviews`.
 */
export function resolveAdminDecisionPlan(
  plans: readonly AdminDecisionPlan[],
  requestedPlanId?: string | null,
): Pick<AdminDecisionSummary, "selectedPlan"> {
  const planId = requestedPlanId?.trim() || null;
  if (planId) {
    const selectedPlan = plans.find((plan) => plan.id === planId);
    if (!selectedPlan) throw new ApiError(404, "PLAN_NOT_FOUND", "Plan not found.");
    return { selectedPlan };
  }
  // Do not assume the caller's ordering: pick the highest ordinal explicitly.
  // `@@unique([eventId, ordinal])` makes the newest round unambiguous.
  const newest = plans.reduce<AdminDecisionPlan | null>(
    (best, plan) => (best === null || plan.ordinal > best.ordinal ? plan : best),
    null,
  );
  return { selectedPlan: newest };
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
  const summaries = emptySummaries(abstractIds, args.rubric);
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
  // Per-criterion values, gathered from the SAME reviews that pass the
  // fail-closed check below — so the breakdown never describes a review the
  // total excluded, and vice versa. Keyed abstract → rubric key → values.
  const criterionValuesByAbstract = new Map<string, Map<string, number[]>>();
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

    // Recorded only after the review has been accepted in full, so a review
    // rejected for one bad criterion contributes to none of them.
    let byCriterion = criterionValuesByAbstract.get(assignment.abstractId);
    if (!byCriterion) {
      byCriterion = new Map();
      criterionValuesByAbstract.set(assignment.abstractId, byCriterion);
    }
    for (const criterion of args.rubric) {
      const score = scoresByKey.get(criterion.key);
      if (score === undefined) continue;
      const criterionValues = byCriterion.get(criterion.key) ?? [];
      criterionValues.push(score);
      byCriterion.set(criterion.key, criterionValues);
    }
  }

  for (const [abstractId, values] of weightedByAbstract) {
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    summaries[abstractId].weightedAverage = Number.isFinite(average) ? average : null;
  }

  for (const [abstractId, byCriterion] of criterionValuesByAbstract) {
    for (const criterion of summaries[abstractId].criteria) {
      const values = byCriterion.get(criterion.key);
      if (!values || values.length === 0) continue;
      const average = values.reduce((sum, value) => sum + value, 0) / values.length;
      criterion.reviews = values.length;
      criterion.average = Number.isFinite(average) ? average : null;
    }
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
    const { selectedPlan } = resolveAdminDecisionPlan(planOptions, input.planId);
    const base = {
      plans: planOptions,
      selectedPlan,
      summariesByAbstractId: emptySummaries(abstractIds),
      // No round selected, or nothing to score against it: there is no rubric
      // in play, so there is nothing to report as unreadable.
      rubricUnreadable: false,
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

    // B3: parsed once, so the flag the board renders and the rubric the
    // aggregate uses can never describe different things.
    const rubric = parseDecisionRubric(selected.rubric);
    if (rubric === null) {
      // Server-side, once per read, and deliberately without the rubric value:
      // it is operator input of unknown shape and this line goes to the
      // platform log. The plan id is what an operator needs to go fix it.
      console.error("[decision-summary] round rubric failed to parse", {
        planId: selectedPlan.id,
        eventId: ctx.eventId,
      });
    }

    return {
      ...base,
      rubricUnreadable: rubric === null,
      summariesByAbstractId: summarizeCompletedDecisionReviews({
        abstractIds,
        rubric,
        assignments,
        scores,
      }),
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
