import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseDecisionRubric,
  resolveAdminDecisionPlan,
  summarizeCompletedDecisionReviews,
} from "./admin-decision-summary";
import { assertEventQueryBound, OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";

const plans = [
  { id: "plan-1", name: "First round", ordinal: 1 },
  { id: "plan-2", name: "Second round", ordinal: 2 },
];

const rubric = [
  { key: "impact", label: "Impact", min: 1, max: 5, weight: 2 },
  { key: "clarity", label: "Clarity", min: 1, max: 5, weight: 1 },
];

test("decision summary defaults to the newest round and honours an explicit choice", () => {
  assert.deepEqual(resolveAdminDecisionPlan([], undefined), { selectedPlan: null });
  assert.deepEqual(resolveAdminDecisionPlan([plans[0]], undefined), { selectedPlan: plans[0] });
  // Several rounds no longer render inert placeholders: the newest is shown.
  assert.deepEqual(resolveAdminDecisionPlan(plans, undefined), { selectedPlan: plans[1] });
  // The newest round is the highest ordinal, not the last argument.
  assert.deepEqual(resolveAdminDecisionPlan([plans[1], plans[0]], undefined), {
    selectedPlan: plans[1],
  });
  assert.deepEqual(resolveAdminDecisionPlan(plans, "plan-1"), { selectedPlan: plans[0] });
  assert.deepEqual(resolveAdminDecisionPlan(plans, "  "), { selectedPlan: plans[1] });
  assert.throws(
    () => resolveAdminDecisionPlan(plans, "other-event-plan"),
    (error: unknown) =>
      error instanceof Error && "status" in error && "code" in error &&
      error.status === 404 && error.code === "PLAN_NOT_FOUND",
  );
});

test("decision summary averages complete per-review weighted scores without identities", () => {
  const summaries = summarizeCompletedDecisionReviews({
    abstractIds: ["abstract-1"],
    rubric: parseDecisionRubric(rubric),
    assignments: [
      { abstractId: "abstract-1", evaluatorId: "reviewer-a" },
      { abstractId: "abstract-1", evaluatorId: "reviewer-b" },
      { abstractId: "abstract-1", evaluatorId: "incomplete-reviewer" },
    ],
    scores: [
      { abstractId: "abstract-1", evaluatorId: "reviewer-a", rubricKey: "impact", score: 4 },
      { abstractId: "abstract-1", evaluatorId: "reviewer-a", rubricKey: "clarity", score: 2 },
      { abstractId: "abstract-1", evaluatorId: "reviewer-b", rubricKey: "impact", score: 5 },
      { abstractId: "abstract-1", evaluatorId: "reviewer-b", rubricKey: "clarity", score: 5 },
      { abstractId: "abstract-1", evaluatorId: "incomplete-reviewer", rubricKey: "impact", score: 3 },
    ],
  });

  assert.deepEqual(summaries["abstract-1"], {
    completedAssignments: 3,
    includedReviews: 2,
    weightedAverage: (10 / 3 + 5) / 2,
    // The organizer breakdown: an aggregate per criterion, over exactly the two
    // reviews the total included. `incomplete-reviewer`'s lone impact score of
    // 3 is excluded from BOTH, so 4.5 rather than (4+5+3)/3.
    criteria: [
      { key: "impact", label: "Impact", weight: 2, min: 1, max: 5, average: 4.5, reviews: 2 },
      { key: "clarity", label: "Clarity", weight: 1, min: 1, max: 5, average: 3.5, reviews: 2 },
    ],
  });
  // The breakdown must not become a route by which a reviewer identity reaches
  // an organizer screen — the whole point of aggregating it server-side.
  assert.equal(JSON.stringify(summaries).includes("reviewer-a"), false);
  assert.equal(JSON.stringify(summaries).includes("reviewer-b"), false);
  assert.equal(JSON.stringify(summaries).includes("evaluatorId"), false);
});

test("the criterion breakdown and the total always describe the same review set", () => {
  // One review is complete and valid; the other is missing a criterion. The
  // partial review must contribute to neither the total nor any criterion —
  // an "average" that quietly counted it would misdescribe the score above it.
  const summaries = summarizeCompletedDecisionReviews({
    abstractIds: ["abstract-1"],
    rubric: parseDecisionRubric(rubric),
    assignments: [
      { abstractId: "abstract-1", evaluatorId: "complete" },
      { abstractId: "abstract-1", evaluatorId: "partial" },
    ],
    scores: [
      { abstractId: "abstract-1", evaluatorId: "complete", rubricKey: "impact", score: 4 },
      { abstractId: "abstract-1", evaluatorId: "complete", rubricKey: "clarity", score: 2 },
      { abstractId: "abstract-1", evaluatorId: "partial", rubricKey: "impact", score: 1 },
    ],
  });
  const summary = summaries["abstract-1"];
  assert.equal(summary.includedReviews, 1);
  assert.equal(summary.criteria.length, 2);
  for (const criterion of summary.criteria) {
    assert.equal(criterion.reviews, summary.includedReviews, criterion.key);
  }
  assert.equal(summary.criteria[0].average, 4, "the excluded review's 1 must not drag impact down");
  assert.equal(summary.criteria[1].average, 2);
});

test("a rubric with no included review still names what the round scores against", () => {
  // An organizer must be able to read the rubric before any review lands.
  // Absence is an em-dash case in the UI, not a zero: `average` stays null.
  const summaries = summarizeCompletedDecisionReviews({
    abstractIds: ["abstract-1"],
    rubric: parseDecisionRubric(rubric),
    assignments: [],
    scores: [],
  });
  assert.deepEqual(summaries["abstract-1"], {
    completedAssignments: 0,
    includedReviews: 0,
    weightedAverage: null,
    criteria: [
      { key: "impact", label: "Impact", weight: 2, min: 1, max: 5, average: null, reviews: 0 },
      { key: "clarity", label: "Clarity", weight: 1, min: 1, max: 5, average: null, reviews: 0 },
    ],
  });
  // Stored order, not weight order: the rubric is the author's own sequence.
  assert.deepEqual(summaries["abstract-1"].criteria.map((c) => c.key), ["impact", "clarity"]);
});

test("decision summary fails closed for malformed rubrics, duplicate keys, and invalid review rows", () => {
  const assignment = [{ abstractId: "abstract-1", evaluatorId: "reviewer-a" }];
  const completeScores = [
    { abstractId: "abstract-1", evaluatorId: "reviewer-a", rubricKey: "impact", score: 4 },
    { abstractId: "abstract-1", evaluatorId: "reviewer-a", rubricKey: "clarity", score: 3 },
  ];
  const invalidRubric = parseDecisionRubric([
    { key: "impact", label: "Impact", min: 1, max: 5, weight: 1 },
    { key: "impact", label: "Impact again", min: 1, max: 5, weight: 1 },
  ]);
  assert.equal(invalidRubric, null);
  assert.equal(
    parseDecisionRubric([{ key: " has-space", label: "Invalid", min: 1, max: 5, weight: 1 }]),
    null,
  );
  assert.equal(
    parseDecisionRubric(Array.from({ length: 251 }, (_, index) => ({
      key: `criterion_${index}`,
      label: `Criterion ${index}`,
      min: 1,
      max: 5,
      weight: 1,
    }))),
    null,
  );

  const malformedPlan = summarizeCompletedDecisionReviews({
    abstractIds: ["abstract-1"],
    rubric: invalidRubric,
    assignments: assignment,
    scores: completeScores,
  });
  assert.deepEqual(malformedPlan["abstract-1"], {
    completedAssignments: 1,
    includedReviews: 0,
    weightedAverage: null,
    // An unreadable rubric blanks the breakdown for the same reason it blanks
    // the score: naming criteria we could not parse would be an invention.
    criteria: [],
  });

  const duplicateScores = summarizeCompletedDecisionReviews({
    abstractIds: ["abstract-1"],
    rubric: parseDecisionRubric(rubric),
    assignments: assignment,
    scores: [...completeScores, { ...completeScores[1] }],
  });
  assert.equal(duplicateScores["abstract-1"].includedReviews, 0);

  const invalidScore = summarizeCompletedDecisionReviews({
    abstractIds: ["abstract-1"],
    rubric: parseDecisionRubric(rubric),
    assignments: assignment,
    scores: [{ ...completeScores[0], score: 99 }, completeScores[1]],
  });
  assert.equal(invalidScore["abstract-1"].includedReviews, 0);

  const foreignAndMissingScore = summarizeCompletedDecisionReviews({
    abstractIds: ["abstract-1"],
    rubric: parseDecisionRubric(rubric),
    assignments: assignment,
    scores: [
      completeScores[0],
      { ...completeScores[1], rubricKey: "foreign_criterion" },
    ],
  });
  assert.equal(foreignAndMissingScore["abstract-1"].includedReviews, 0);
});

test("C15 service keeps its authorization, snapshot, and cap-plus-one boundaries explicit", () => {
  const source = readFileSync(new URL("./admin-decision-summary.ts", import.meta.url), "utf8");
  assert.match(source, /ctx\.role !== "ADMIN"/);
  assert.match(source, /Prisma\.TransactionIsolationLevel\.RepeatableRead/);
  assert.match(source, /adminDecisionPlans \+ 1/);
  assert.match(source, /adminDecisionAssignments \+ 1/);
  assert.match(source, /adminDecisionScores \+ 1/);
  assert.match(source, /assertEventQueryBound\(plans/);
  assert.match(source, /assertEventQueryBound\(\s*assignments/);
  assert.match(source, /assertEventQueryBound\(scores/);
});

test("decision summaries admit the 100-row page plus one separately selected older abstract", () => {
  assert.equal(
    OPERATOR_QUERY_LIMITS.adminDecisionAbstracts,
    OPERATOR_QUERY_LIMITS.adminAbstracts + 1,
  );
  assert.doesNotThrow(() =>
    assertEventQueryBound(
      { length: OPERATOR_QUERY_LIMITS.adminDecisionAbstracts },
      OPERATOR_QUERY_LIMITS.adminDecisionAbstracts,
      "decision-summary abstracts",
    ),
  );
  assert.throws(
    () =>
      assertEventQueryBound(
        { length: OPERATOR_QUERY_LIMITS.adminDecisionAbstracts + 1 },
        OPERATOR_QUERY_LIMITS.adminDecisionAbstracts,
        "decision-summary abstracts",
      ),
    (error: unknown) =>
      error instanceof Error && "status" in error && "code" in error &&
      error.status === 422 && error.code === "EVENT_QUERY_LIMIT_EXCEEDED",
  );
  const source = readFileSync(new URL("./admin-decision-summary.ts", import.meta.url), "utf8");
  assert.match(source, /OPERATOR_QUERY_LIMITS\.adminDecisionAbstracts/);
});

test("C15 API is admin-only and sends selected-round summaries without raw scores or progress", () => {
  const route = readFileSync(new URL("../../app/api/cfp/submissions/route.ts", import.meta.url), "utf8");
  const getRoute = route.slice(route.indexOf("export const GET"), route.indexOf("export const POST"));
  assert.match(getRoute, /requireContext\(\["ADMIN"\]\)/);
  assert.match(getRoute, /getAdminDecisionSummary\(ctx/);
  assert.match(getRoute, /serializeAdminAbstract/);
  assert.doesNotMatch(getRoute, /reviewScores/);
  assert.doesNotMatch(getRoute, /reviewAssignments/);
});

test("evaluator assignment API remains assignment-scoped and omits evaluator identity", () => {
  const route = readFileSync(new URL("../../app/api/evaluations/assignments/route.ts", import.meta.url), "utf8");
  const getRoute = route.slice(route.indexOf("export const GET"), route.indexOf("export const POST"));
  assert.match(getRoute, /ctx\.role === "EVALUATOR" \? \{ evaluatorId: ctx\.userId \}/);
  assert.match(getRoute, /plan\.isBlind && ctx\.role === "EVALUATOR"/);
  assert.match(getRoute, /ctx\.role === "ADMIN" \? \{ evaluator: a\.evaluator \}/);
});
