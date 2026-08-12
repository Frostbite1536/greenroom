import assert from "node:assert/strict";
import test from "node:test";
import {
  DECIDED_STATUSES,
  FUNNEL_COLUMNS,
  formatMinutes,
  formatRate,
  speakerReadiness,
  summarizeCategoryFunnel,
  summarizeReviewLoad,
  summarizeScheduleUtilization,
  summarizeSubmissionPacing,
  summarizeSpeakerReadiness,
  type CategoryStatusCount,
} from "@/lib/reports/metrics";
import { ABSTRACT_FUNNEL_STATUSES } from "@/lib/abstract-status";
import type { SpeakerStatusRow } from "@/lib/speakers/status";

// ---- submission pacing ----------------------------------------------------

test("submission pacing groups submitted timestamps in the event timezone", () => {
  const pacing = summarizeSubmissionPacing([
    { submittedAt: "2026-05-12T06:30:00.000Z" }, // May 11 in Los Angeles
    { submittedAt: "2026-05-12T07:30:00.000Z" },
    { submittedAt: new Date("2026-05-13T18:00:00.000Z") },
  ], "America/Los_Angeles");
  assert.deepEqual(pacing, {
    rows: [
      { dateKey: "2026-05-11", submitted: 1, cumulative: 1 },
      { dateKey: "2026-05-12", submitted: 1, cumulative: 2 },
      { dateKey: "2026-05-13", submitted: 1, cumulative: 3 },
    ],
    total: 3,
    peak: 1,
    rangeTruncated: false,
  });
});

test("submission pacing sorts days, accumulates counts and stays empty without submissions", () => {
  const pacing = summarizeSubmissionPacing([
    { submittedAt: "2026-05-14T12:00:00.000Z" },
    { submittedAt: "2026-05-12T12:00:00.000Z" },
    { submittedAt: "2026-05-14T13:00:00.000Z" },
  ], "UTC");
  assert.deepEqual(pacing.rows, [
    { dateKey: "2026-05-12", submitted: 1, cumulative: 1 },
    { dateKey: "2026-05-13", submitted: 0, cumulative: 1 },
    { dateKey: "2026-05-14", submitted: 2, cumulative: 3 },
  ]);
  assert.equal(pacing.total, 3);
  assert.equal(pacing.peak, 2);
  assert.deepEqual(summarizeSubmissionPacing([], "UTC"), { rows: [], total: 0, peak: 0, rangeTruncated: false });
});

test("submission pacing bounds a multi-year range to the latest 366 calendar days", () => {
  const pacing = summarizeSubmissionPacing([
    { submittedAt: "2020-01-01T12:00:00.000Z" },
    { submittedAt: "2026-01-01T12:00:00.000Z" },
  ], "UTC");
  assert.equal(pacing.rangeTruncated, true);
  assert.equal(pacing.rows.length, 366);
  assert.equal(pacing.rows[0].dateKey, "2025-01-01");
  assert.equal(pacing.rows.at(-1)?.dateKey, "2026-01-01");
  assert.equal(pacing.total, 1);
});

test("submission pacing keeps zero days across a daylight-saving boundary", () => {
  const pacing = summarizeSubmissionPacing([
    { submittedAt: "2026-03-07T20:00:00.000Z" },
    { submittedAt: "2026-03-10T20:00:00.000Z" },
  ], "America/Chicago");
  assert.deepEqual(pacing.rows, [
    { dateKey: "2026-03-07", submitted: 1, cumulative: 1 },
    { dateKey: "2026-03-08", submitted: 0, cumulative: 1 },
    { dateKey: "2026-03-09", submitted: 0, cumulative: 1 },
    { dateKey: "2026-03-10", submitted: 1, cumulative: 2 },
  ]);
});

// ---- per-category funnel ---------------------------------------------------

const CATEGORIES = [
  { id: "cat-platform", name: "Platform" },
  { id: "cat-ml", name: "Machine learning" },
];

const group = (
  categoryId: string | null,
  status: CategoryStatusCount["status"],
  n: number,
): CategoryStatusCount => ({ categoryId, status, _count: { _all: n } });

test("the funnel's columns are the abstracts page's own chips, in chip order", () => {
  assert.deepEqual(
    FUNNEL_COLUMNS.map((column) => column.status),
    ABSTRACT_FUNNEL_STATUSES,
  );
  // Chip labels, not renamed statuses: REJECTED reads "Declined" on the table.
  assert.equal(FUNNEL_COLUMNS.find((column) => column.status === "REJECTED")?.label, "Declined");
  assert.equal(FUNNEL_COLUMNS.find((column) => column.status === "DRAFT")?.label, "Drafts");
});

test("acceptance is accepted over decided, and a maybe is not decided", () => {
  // The rule is grounded in decisionTimestamp(): MAYBE never stamps decidedAt.
  assert.deepEqual([...DECIDED_STATUSES], ["ACCEPTED", "REJECTED"]);
  const funnel = summarizeCategoryFunnel(
    [
      group("cat-platform", "ACCEPTED", 3),
      group("cat-platform", "REJECTED", 1),
      group("cat-platform", "MAYBE", 4),
      group("cat-platform", "WITHDRAWN", 2),
    ],
    CATEGORIES,
  );
  const platform = funnel.rows[0]!;
  assert.equal(platform.decided, 4);
  assert.equal(platform.accepted, 3);
  assert.equal(platform.acceptanceRate, 0.75);
});

test("a category with no decisions reports no rate rather than zero percent", () => {
  // 0% against an open call is a finding an organizer would act on; "—" is not.
  const funnel = summarizeCategoryFunnel([group("cat-ml", "SUBMITTED", 5)], CATEGORIES);
  const ml = funnel.rows.find((row) => row.categoryId === "cat-ml")!;
  assert.equal(ml.acceptanceRate, null);
  assert.equal(formatRate(ml.acceptanceRate), "—");
  assert.equal(formatRate(0), "0%");
});

test("submitted excludes drafts, matching the dashboard funnel's own rule", () => {
  const funnel = summarizeCategoryFunnel(
    [group("cat-platform", "DRAFT", 4), group("cat-platform", "SUBMITTED", 6)],
    CATEGORIES,
  );
  const platform = funnel.rows[0]!;
  assert.equal(platform.total, 10);
  assert.equal(platform.submitted, 6);
});

test("an untouched category still gets a row, and a null category gets its own", () => {
  const funnel = summarizeCategoryFunnel([group(null, "SUBMITTED", 2)], CATEGORIES);
  assert.deepEqual(funnel.rows.map((row) => row.categoryName), [
    "Platform", "Machine learning", "No category",
  ]);
  assert.equal(funnel.rows[0]!.total, 0);
  assert.equal(funnel.rows.at(-1)!.categoryId, null);
});

test("a proposal whose category was deleted lands in the uncategorized row", () => {
  // The category id survives the group but names nothing; dropping the row
  // would make the report's total disagree with the abstracts table's.
  const funnel = summarizeCategoryFunnel(
    [group("cat-deleted", "ACCEPTED", 3), group("cat-platform", "ACCEPTED", 1)],
    CATEGORIES,
  );
  assert.equal(funnel.rows.at(-1)!.categoryName, "No category");
  assert.equal(funnel.rows.at(-1)!.counts.ACCEPTED, 3);
  assert.equal(funnel.totals.counts.ACCEPTED, 4);
});

test("the totals row is the column sum, so the foot cannot contradict the body", () => {
  const funnel = summarizeCategoryFunnel(
    [
      group("cat-platform", "ACCEPTED", 2),
      group("cat-ml", "ACCEPTED", 3),
      group("cat-ml", "REJECTED", 5),
      group(null, "DRAFT", 1),
    ],
    CATEGORIES,
  );
  for (const status of ABSTRACT_FUNNEL_STATUSES) {
    assert.equal(
      funnel.totals.counts[status],
      funnel.rows.reduce((sum, row) => sum + row.counts[status], 0),
      status,
    );
  }
  assert.equal(funnel.totals.accepted, 5);
  assert.equal(funnel.totals.decided, 10);
  assert.equal(funnel.totals.acceptanceRate, 0.5);
});

test("an event with no categories and no proposals folds to an empty report", () => {
  const funnel = summarizeCategoryFunnel([], []);
  assert.deepEqual(funnel.rows, []);
  assert.equal(funnel.totals.total, 0);
  assert.equal(funnel.totals.acceptanceRate, null);
});

// ---- review load -----------------------------------------------------------

const EVALUATORS = [
  { userId: "u-ada", name: "Ada Lovelace" },
  { userId: "u-grace", name: "Grace Hopper" },
  { userId: "u-alan", name: "Alan Turing" },
];

test("load splits assigned into completed and outstanding per reviewer", () => {
  const load = summarizeReviewLoad(
    [
      { evaluatorId: "u-ada", status: "COMPLETED", _count: { _all: 4 } },
      { evaluatorId: "u-ada", status: "ASSIGNED", _count: { _all: 2 } },
      { evaluatorId: "u-grace", status: "IN_PROGRESS", _count: { _all: 3 } },
    ],
    EVALUATORS,
  );
  const ada = load.rows.find((row) => row.userId === "u-ada")!;
  assert.equal(ada.assigned, 6);
  assert.equal(ada.completed, 4);
  assert.equal(ada.outstanding, 2);
  assert.equal(load.assigned, 9);
  assert.equal(load.completed, 4);
  assert.equal(load.outstanding, 5);
});

test("a declined assignment is outstanding work, not finished work", () => {
  const load = summarizeReviewLoad(
    [{ evaluatorId: "u-ada", status: "DECLINED", _count: { _all: 2 } }],
    EVALUATORS,
  );
  const ada = load.rows.find((row) => row.userId === "u-ada")!;
  assert.equal(ada.completed, 0);
  assert.equal(ada.outstanding, 2);
});

test("a reviewer given nothing still gets a row — that is the finding", () => {
  const load = summarizeReviewLoad([], EVALUATORS);
  assert.equal(load.rows.length, 3);
  assert.equal(load.rows[0]!.assigned, 0);
  assert.equal(load.rows[0]!.completionRate, null);
});

test("rows are ordered most-outstanding first, then alphabetically", () => {
  const load = summarizeReviewLoad(
    [
      { evaluatorId: "u-ada", status: "ASSIGNED", _count: { _all: 1 } },
      { evaluatorId: "u-grace", status: "ASSIGNED", _count: { _all: 5 } },
    ],
    EVALUATORS,
  );
  assert.deepEqual(load.rows.map((row) => row.name), [
    "Grace Hopper", "Ada Lovelace", "Alan Turing",
  ]);
});

test("an assignment held by a non-member cannot invent a row", () => {
  // The membership read is the roster of reviewers; a stale evaluator id must
  // not materialize a nameless row on an organizer's report.
  const load = summarizeReviewLoad(
    [{ evaluatorId: "u-ghost", status: "COMPLETED", _count: { _all: 9 } }],
    EVALUATORS,
  );
  assert.equal(load.rows.length, 3);
  assert.equal(load.assigned, 0);
});

test("the load type carries no abstract, score, or comment", () => {
  const load = summarizeReviewLoad(
    [{ evaluatorId: "u-ada", status: "COMPLETED", _count: { _all: 1 } }],
    EVALUATORS,
  );
  const serialized = JSON.stringify(load);
  for (const forbidden of ["abstract", "score", "rubric", "comment", "title"]) {
    assert.ok(!serialized.toLowerCase().includes(forbidden), forbidden);
  }
});

// ---- schedule utilization --------------------------------------------------

const ROOMS = [
  { id: "room-main", name: "Main hall" },
  { id: "room-side", name: "Side room" },
];

const slot = (roomId: string, startsAt: string, endsAt: string) => ({ roomId, startsAt, endsAt });

test("booked minutes come from the slot interval, per room and per event day", () => {
  const days = summarizeScheduleUtilization(
    [
      slot("room-main", "2026-05-12T16:00:00.000Z", "2026-05-12T17:00:00.000Z"),
      slot("room-main", "2026-05-12T17:00:00.000Z", "2026-05-12T17:30:00.000Z"),
      slot("room-side", "2026-05-12T16:30:00.000Z", "2026-05-12T17:00:00.000Z"),
    ],
    ROOMS,
    ["2026-05-12"],
    "UTC",
  );
  assert.equal(days.length, 1);
  const [day] = days;
  assert.equal(day!.slots, 3);
  assert.equal(day!.bookedMinutes, 120);
  // 16:00 → 17:30 is a 90-minute programme span.
  assert.equal(day!.spanMinutes, 90);
  const main = day!.rooms.find((room) => room.roomId === "room-main")!;
  assert.equal(main.bookedMinutes, 90);
  assert.equal(main.utilization, 1);
  const side = day!.rooms.find((room) => room.roomId === "room-side")!;
  assert.equal(side.bookedMinutes, 30);
  assert.equal(side.utilization, 1 / 3);
});

test("an idle room is reported as a zero row, not omitted", () => {
  const [day] = summarizeScheduleUtilization(
    [slot("room-main", "2026-05-12T16:00:00.000Z", "2026-05-12T17:00:00.000Z")],
    ROOMS,
    ["2026-05-12"],
    "UTC",
  );
  const side = day!.rooms.find((room) => room.roomId === "room-side")!;
  assert.equal(side.slots, 0);
  assert.equal(side.bookedMinutes, 0);
  assert.equal(side.utilization, 0);
});

test("an event day with nothing placed still appears, with no span to divide by", () => {
  const days = summarizeScheduleUtilization([], ROOMS, ["2026-05-12", "2026-05-13"], "UTC");
  assert.deepEqual(days.map((day) => day.dateKey), ["2026-05-12", "2026-05-13"]);
  assert.equal(days[0]!.spanMinutes, 0);
  assert.equal(days[0]!.startMinutes, null);
  // Never Infinity or NaN: a day with no programme has no utilization.
  assert.equal(days[0]!.rooms[0]!.utilization, null);
});

test("a slot outside the stored event days is never invisible", () => {
  const days = summarizeScheduleUtilization(
    [slot("room-main", "2026-05-20T16:00:00.000Z", "2026-05-20T17:00:00.000Z")],
    ROOMS,
    ["2026-05-12"],
    "UTC",
  );
  assert.deepEqual(days.map((day) => day.dateKey), ["2026-05-12", "2026-05-20"]);
  assert.equal(days[1]!.bookedMinutes, 60);
});

test("days are keyed in the event's zone, not the runtime's", () => {
  // 2026-05-13T03:00Z is still the evening of 12 May in Los Angeles.
  const days = summarizeScheduleUtilization(
    [slot("room-main", "2026-05-13T03:00:00.000Z", "2026-05-13T04:00:00.000Z")],
    ROOMS,
    [],
    "America/Los_Angeles",
  );
  assert.deepEqual(days.map((day) => day.dateKey), ["2026-05-12"]);
  assert.equal(days[0]!.startMinutes, 20 * 60);
});

test("a slot running past local midnight extends the span rather than shrinking it", () => {
  // Deriving the end from minutes-of-day would read 00:30 as 30 and produce a
  // negative span; the end is start + length instead.
  const [day] = summarizeScheduleUtilization(
    [slot("room-main", "2026-05-12T23:00:00.000Z", "2026-05-13T00:30:00.000Z")],
    ROOMS,
    [],
    "UTC",
  );
  assert.equal(day!.spanMinutes, 90);
  assert.equal(day!.rooms[0]!.utilization, 1);
});

test("a broken interval contributes no minutes but is still counted as placed", () => {
  const [day] = summarizeScheduleUtilization(
    [
      slot("room-main", "2026-05-12T16:00:00.000Z", "2026-05-12T15:00:00.000Z"),
      slot("room-main", "2026-05-12T16:00:00.000Z", "not-a-date"),
    ],
    ROOMS,
    [],
    "UTC",
  );
  assert.equal(day!.slots, 2);
  assert.equal(day!.bookedMinutes, 0);
});

test("durations are rendered in one vocabulary", () => {
  assert.equal(formatMinutes(0), "—");
  assert.equal(formatMinutes(45), "45m");
  assert.equal(formatMinutes(60), "1h");
  assert.equal(formatMinutes(390), "6h 30m");
});

// ---- speaker readiness -----------------------------------------------------

function speaker(overrides: Partial<SpeakerStatusRow>): SpeakerStatusRow {
  return {
    userId: "u-1", name: "Speaker", email: "s@example.test",
    company: null, jobTitle: null, bio: null, headshotUrl: null,
    status: "CONFIRMED", sessionCount: 1, scheduledCount: 1, sessionTitles: ["Talk"],
    profilePercent: 100, profileMissing: [], tasksDone: 1, tasksTotal: 1,
    requiredOutstanding: [], nextRequiredDueAt: null, overdueRequired: 0,
    onboardingComplete: true, needsAttention: false,
    ...overrides,
  };
}

test("the readiness ladder is the roster's own pill order and is exclusive", () => {
  assert.equal(speakerReadiness(speaker({})), "ready");
  assert.equal(
    speakerReadiness(speaker({ onboardingComplete: false, requiredOutstanding: ["Headshot"] })),
    "onboarding",
  );
  assert.equal(
    speakerReadiness(speaker({ onboardingComplete: false, profileMissing: ["Bio"] })),
    "profile",
  );
});

test("readiness is measured over the confirmed cohort and buckets sum to it", () => {
  const cohort = [
    speaker({ userId: "a" }),
    speaker({ userId: "b", onboardingComplete: false, requiredOutstanding: ["Slides"], overdueRequired: 1 }),
    speaker({ userId: "c", onboardingComplete: false, profileMissing: ["Bio"] }),
  ];
  const awaiting = speaker({ userId: "d", sessionCount: 0, scheduledCount: 0, sessionTitles: [], status: "INVITED" });
  const readiness = summarizeSpeakerReadiness([...cohort, awaiting], cohort);

  assert.equal(readiness.cohort, 3);
  assert.equal(readiness.buckets.reduce((sum, bucket) => sum + bucket.count, 0), 3);
  assert.deepEqual(readiness.buckets.map((bucket) => [bucket.key, bucket.count]), [
    ["ready", 1], ["onboarding", 1], ["profile", 1],
  ]);
  // The speaker with no session is outside the cohort, reported separately —
  // exactly as the dashboard reports them.
  assert.equal(readiness.awaitingSession, 1);
  assert.equal(readiness.overdue, 1);
});

test("confirmation is counted across the whole roster, cohort or not", () => {
  const cohort = [speaker({ userId: "a", status: "CONFIRMED" })];
  const readiness = summarizeSpeakerReadiness(
    [...cohort, speaker({ userId: "b", sessionCount: 0, status: "DECLINED" })],
    cohort,
  );
  assert.deepEqual(readiness.confirmation, [
    { status: "CONFIRMED", count: 1 },
    { status: "INVITED", count: 0 },
    { status: "DECLINED", count: 1 },
  ]);
});

test("unscheduled sessions are counted the roster's way, per session not per speaker", () => {
  const cohort = [speaker({ userId: "a", sessionCount: 3, scheduledCount: 1 })];
  assert.equal(summarizeSpeakerReadiness(cohort, cohort).unscheduledSessions, 2);
});

test("an empty roster folds to zeroes with no bucket dropped", () => {
  const readiness = summarizeSpeakerReadiness([], []);
  assert.equal(readiness.cohort, 0);
  assert.equal(readiness.buckets.length, 3);
  assert.equal(readiness.awaitingSession, 0);
});
