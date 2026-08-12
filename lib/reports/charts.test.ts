/**
 * The chart geometry behind `/admin/reports`.
 *
 * `metrics.test.ts` pins what the numbers are; this pins what gets drawn for
 * them — one bar per fold row, widths proportional to the value, a direct label
 * on every bar, and no chart at all where there is nothing honest to draw. The
 * cases that make a chart lie are the ones tested hardest: a value too small to
 * see, a track that would overflow because of that floor, a zero row, and an
 * empty fold.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  categoryFunnelChart,
  reviewLoadChart,
  scheduleUtilizationChart,
  submissionPacingChart,
  speakerReadinessChart,
  type BarChart,
} from "@/lib/reports/charts";
import {
  summarizeCategoryFunnel,
  summarizeReviewLoad,
  summarizeScheduleUtilization,
  summarizeSubmissionPacing,
  summarizeSpeakerReadiness,
  type CategoryStatusCount,
  type EvaluatorAssignmentGroup,
} from "@/lib/reports/metrics";
import type { SpeakerStatusRow } from "@/lib/speakers/status";

const CATEGORIES = [
  { id: "cat-platform", name: "Platform" },
  { id: "cat-ml", name: "Machine learning" },
];

const group = (
  categoryId: string | null,
  status: CategoryStatusCount["status"],
  n: number,
): CategoryStatusCount => ({ categoryId, status, _count: { _all: n } });

/** Total drawn width of one bar, in percent of its track. */
const drawn = (chart: BarChart, index: number) =>
  chart.bars[index]!.segments.reduce((sum, segment) => sum + segment.width, 0);

/** Every builder must leave a chart inside its track. */
function assertInsideTrack(chart: BarChart) {
  for (const [index, bar] of chart.bars.entries()) {
    const total = drawn(chart, index);
    assert.ok(total <= 100 + 1e-9, `bar ${bar.key} overflows its track at ${total}%`);
    let x = 0;
    for (const segment of bar.segments) {
      assert.equal(Number(segment.x.toFixed(6)), Number(x.toFixed(6)), `bar ${bar.key} has a gap`);
      assert.ok(segment.width > 0, `bar ${bar.key} draws a zero-width segment`);
      x += segment.width;
    }
  }
}

// ---- 0. Submission pacing -------------------------------------------------

test("submission pacing draws active days against the peak with exact cumulative labels", () => {
  const pacing = summarizeSubmissionPacing([
    { submittedAt: "2026-05-12T10:00:00.000Z" },
    { submittedAt: "2026-05-13T10:00:00.000Z" },
    { submittedAt: "2026-05-13T11:00:00.000Z" },
  ], "UTC");
  const chart = submissionPacingChart(pacing)!;
  assert.deepEqual(chart.bars.map((bar) => [bar.key, bar.value, bar.note]), [
    ["2026-05-12", "1", "1 total"],
    ["2026-05-13", "2", "3 total"],
  ]);
  assert.equal(drawn(chart, 0), 50);
  assert.equal(drawn(chart, 1), 100);
  assert.match(chart.ariaLabel, /3 proposals submitted/);
  assertInsideTrack(chart);
});

test("submission pacing has no chart without actual submissions", () => {
  assert.equal(submissionPacingChart(summarizeSubmissionPacing([], "UTC")), null);
});

// ---- 1. Per-category funnel ------------------------------------------------

test("the funnel draws one bar per category row, in the fold's order", () => {
  const funnel = summarizeCategoryFunnel(
    [group("cat-platform", "ACCEPTED", 6), group("cat-ml", "SUBMITTED", 3), group(null, "DRAFT", 1)],
    CATEGORIES,
  );
  const chart = categoryFunnelChart(funnel);
  assert.ok(chart);
  assert.equal(chart.bars.length, funnel.rows.length);
  assert.deepEqual(
    chart.bars.map((bar) => bar.label),
    funnel.rows.map((row) => row.categoryName),
  );
  assertInsideTrack(chart);
});

test("bar length is proportional to the category's total, against the largest", () => {
  const funnel = summarizeCategoryFunnel(
    [group("cat-platform", "ACCEPTED", 8), group("cat-ml", "ACCEPTED", 4)],
    CATEGORIES,
  );
  const chart = categoryFunnelChart(funnel)!;
  // The biggest category fills the track; half the proposals draw half of it.
  assert.equal(drawn(chart, 0), 100);
  assert.equal(drawn(chart, 1), 50);
});

test("segments sit in chip order and carry the chip's own label and value", () => {
  const funnel = summarizeCategoryFunnel(
    [
      group("cat-platform", "SUBMITTED", 2),
      group("cat-platform", "ACCEPTED", 5),
      group("cat-platform", "REJECTED", 3),
    ],
    CATEGORIES,
  );
  const platform = categoryFunnelChart(funnel)!.bars[0]!;
  assert.deepEqual(platform.segments.map((segment) => segment.key), [
    "SUBMITTED",
    "ACCEPTED",
    "REJECTED",
  ]);
  // "Declined", not "Rejected": the chart speaks the abstracts page's vocabulary.
  assert.equal(platform.segments[2]!.title, "Declined: 3");
  // Direct labels, not a legend: the total and the rate ride beside the bar.
  assert.equal(platform.value, "10");
  assert.equal(platform.note, "63%");
});

test("a category nobody submitted to keeps its row and draws nothing", () => {
  // The fold emits the empty row on purpose; the chart must not invent a bar
  // for it, and must not drop the row either.
  const funnel = summarizeCategoryFunnel([group("cat-platform", "ACCEPTED", 4)], CATEGORIES);
  const chart = categoryFunnelChart(funnel)!;
  const ml = chart.bars.find((bar) => bar.label === "Machine learning")!;
  assert.deepEqual(ml.segments, []);
  assert.equal(ml.value, "0");
  assert.equal(ml.note, "—");
});

test("one proposal among hundreds still draws a visible sliver, labelled honestly", () => {
  const funnel = summarizeCategoryFunnel(
    [group("cat-platform", "ACCEPTED", 400), group("cat-ml", "ACCEPTED", 1)],
    CATEGORIES,
  );
  const chart = categoryFunnelChart(funnel)!;
  const sliver = chart.bars[1]!.segments[0]!;
  assert.ok(sliver.width >= 1.2, `a single proposal rounded away to ${sliver.width}%`);
  // The floor exaggerates a pixel, never a number.
  assert.equal(sliver.value, 1);
  assert.equal(chart.bars[1]!.value, "1");
});

test("the floor never pushes a stacked bar past its own track", () => {
  // Seven statuses, six of them a single proposal against a 900-strong bucket:
  // every floor applies at once and the widest segment gives the excess back.
  const funnel = summarizeCategoryFunnel(
    [
      group("cat-platform", "ACCEPTED", 900),
      group("cat-platform", "DRAFT", 1),
      group("cat-platform", "SUBMITTED", 1),
      group("cat-platform", "UNDER_REVIEW", 1),
      group("cat-platform", "MAYBE", 1),
      group("cat-platform", "REJECTED", 1),
      group("cat-platform", "WITHDRAWN", 1),
    ],
    CATEGORIES,
  );
  const chart = categoryFunnelChart(funnel)!;
  assertInsideTrack(chart);
  assert.equal(chart.bars[0]!.segments.length, 7);
  for (const segment of chart.bars[0]!.segments) {
    assert.ok(segment.width >= 1.2, `the give-back cut a segment to ${segment.width}%`);
  }
});

test("geometry is written to a thousandth, so the markup carries no float noise", () => {
  const funnel = summarizeCategoryFunnel(
    [
      group("cat-platform", "ACCEPTED", 12),
      group("cat-platform", "REJECTED", 9),
      group("cat-platform", "MAYBE", 1),
    ],
    CATEGORIES,
  );
  for (const segment of categoryFunnelChart(funnel)!.bars[0]!.segments) {
    for (const value of [segment.x, segment.width]) {
      assert.equal(value, Number(value.toFixed(3)), `${value} would render 17 digits wide`);
    }
  }
});

test("a long category name is shortened for the row and kept for the tooltip", () => {
  const long = "Distributed systems, storage and platform reliability";
  const funnel = summarizeCategoryFunnel([group("cat-long", "ACCEPTED", 2)], [
    { id: "cat-long", name: long },
  ]);
  const bar = categoryFunnelChart(funnel)!.bars[0]!;
  assert.equal(bar.truncated, true);
  assert.ok(bar.display.length <= 24, `display is ${bar.display.length} characters`);
  assert.ok(bar.display.endsWith("…"));
  assert.equal(bar.label, long);
});

test("the legend names only the statuses this event actually used", () => {
  const funnel = summarizeCategoryFunnel(
    [group("cat-platform", "ACCEPTED", 3), group("cat-platform", "REJECTED", 1)],
    CATEGORIES,
  );
  assert.deepEqual(
    categoryFunnelChart(funnel)!.legend.map((item) => item.key),
    ["ACCEPTED", "REJECTED"],
  );
});

test("a call with no proposals gets no chart, not a row of empty bars", () => {
  assert.equal(categoryFunnelChart(summarizeCategoryFunnel([], CATEGORIES)), null);
  assert.equal(categoryFunnelChart(summarizeCategoryFunnel([], [])), null);
});

test("the funnel's aria-label summarizes the chart and defers to the table", () => {
  const funnel = summarizeCategoryFunnel(
    [group("cat-platform", "ACCEPTED", 3), group("cat-platform", "REJECTED", 1)],
    CATEGORIES,
  );
  const label = categoryFunnelChart(funnel)!.ariaLabel;
  assert.match(label, /2 categories/);
  assert.match(label, /4 proposals/);
  assert.match(label, /75% accepted/);
  assert.match(label, /table below/);
});

// ---- 2. Review load --------------------------------------------------------

const EVALUATORS = [
  { userId: "u-ana", name: "Ana" },
  { userId: "u-bo", name: "Bo" },
];

const assignment = (
  evaluatorId: string,
  status: string,
  n: number,
): EvaluatorAssignmentGroup => ({ evaluatorId, status, _count: { _all: n } });

test("review load draws completed then outstanding, scaled to the biggest load", () => {
  const review = summarizeReviewLoad(
    [
      assignment("u-ana", "COMPLETED", 6),
      assignment("u-ana", "PENDING", 6),
      assignment("u-bo", "COMPLETED", 3),
    ],
    EVALUATORS,
  );
  const chart = reviewLoadChart(review)!;
  assert.equal(chart.bars.length, review.rows.length);
  const ana = chart.bars.find((bar) => bar.label === "Ana")!;
  assert.deepEqual(ana.segments.map((segment) => segment.key), ["completed", "outstanding"]);
  assert.equal(ana.segments[0]!.width, 50);
  assert.equal(ana.segments[1]!.width, 50);
  assert.equal(ana.value, "6 / 12");
  assert.equal(ana.note, "50%");
  // Bo holds a quarter of Ana's load and draws a quarter of the track.
  const bo = chart.bars.find((bar) => bar.label === "Bo")!;
  assert.equal(drawn(chart, chart.bars.indexOf(bo)), 25);
  assertInsideTrack(chart);
});

test("a reviewer given nothing keeps an empty row, because that is the finding", () => {
  const review = summarizeReviewLoad([assignment("u-ana", "PENDING", 4)], EVALUATORS);
  const bo = reviewLoadChart(review)!.bars.find((bar) => bar.label === "Bo")!;
  assert.deepEqual(bo.segments, []);
  assert.equal(bo.value, "—");
  assert.equal(bo.note, "Nothing assigned");
});

test("the chart keeps the fold's most-outstanding-first order", () => {
  const review = summarizeReviewLoad(
    [assignment("u-ana", "COMPLETED", 5), assignment("u-bo", "PENDING", 2)],
    EVALUATORS,
  );
  assert.deepEqual(
    reviewLoadChart(review)!.bars.map((bar) => bar.label),
    review.rows.map((row) => row.name),
  );
  assert.equal(review.rows[0]!.name, "Bo");
});

test("reviewers with no round assigned get no chart at all", () => {
  assert.equal(reviewLoadChart(summarizeReviewLoad([], EVALUATORS)), null);
  assert.equal(reviewLoadChart(summarizeReviewLoad([], [])), null);
});

// ---- 3. Schedule utilization -----------------------------------------------

const ROOMS = [
  { id: "room-main", name: "Main hall" },
  { id: "room-side", name: "Side room" },
];

const slot = (roomId: string, startsAt: string, endsAt: string) => ({ roomId, startsAt, endsAt });

function oneDay() {
  return summarizeScheduleUtilization(
    [
      // 09:00–13:00 in the main hall, 09:00–11:00 beside it: a four-hour span.
      slot("room-main", "2026-06-04T09:00:00.000Z", "2026-06-04T13:00:00.000Z"),
      slot("room-side", "2026-06-04T09:00:00.000Z", "2026-06-04T11:00:00.000Z"),
    ],
    ROOMS,
    ["2026-06-04"],
    "UTC",
  )[0]!;
}

test("a room's bar is its booked minutes against the day's own span", () => {
  const chart = scheduleUtilizationChart(oneDay(), "Thursday 4 June")!;
  assert.equal(chart.bars.length, ROOMS.length);
  // The room that defines the span reads 100%; the other reads exactly half.
  assert.equal(drawn(chart, 0), 100);
  assert.equal(chart.bars[0]!.value, "100%");
  assert.equal(drawn(chart, 1), 50);
  assert.equal(chart.bars[1]!.value, "50%");
  assert.equal(chart.bars[1]!.note, "2h");
  assertInsideTrack(chart);
});

test("an idle room draws no bar and says so", () => {
  const day = summarizeScheduleUtilization(
    [slot("room-main", "2026-06-04T09:00:00.000Z", "2026-06-04T13:00:00.000Z")],
    ROOMS,
    ["2026-06-04"],
    "UTC",
  )[0]!;
  const side = scheduleUtilizationChart(day, "Thursday 4 June")!.bars[1]!;
  assert.deepEqual(side.segments, []);
  // "0%" is what the table's cell reads for the same room, so the chart's own
  // direct label reads it too — a dash here would disagree with the truth.
  assert.equal(side.value, "0%");
  assert.equal(side.note, "Idle");
});

test("a day with no programme, and an event with no rooms, get no chart", () => {
  const empty = summarizeScheduleUtilization([], ROOMS, ["2026-06-05"], "UTC")[0]!;
  assert.equal(empty.spanMinutes, 0);
  assert.equal(scheduleUtilizationChart(empty, "Friday 5 June"), null);
  const roomless = summarizeScheduleUtilization([], [], ["2026-06-05"], "UTC")[0]!;
  assert.equal(scheduleUtilizationChart(roomless, "Friday 5 June"), null);
});

test("the day chart names its day and its span in the summary", () => {
  const label = scheduleUtilizationChart(oneDay(), "Thursday 4 June")!.ariaLabel;
  assert.match(label, /Thursday 4 June/);
  assert.match(label, /2 rooms/);
  assert.match(label, /6h booked across a 4h program span/);
});

// ---- 4. Speaker readiness --------------------------------------------------

/** The roster row `metrics.test.ts` builds, defaulted to a ready speaker. */
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

test("readiness is one composition bar whose segments fill exactly one track", () => {
  const cohort = [
    speaker({ userId: "a" }),
    speaker({ userId: "b", onboardingComplete: false, requiredOutstanding: ["Headshot"] }),
    speaker({ userId: "c", onboardingComplete: false }),
    speaker({ userId: "d", onboardingComplete: false }),
  ];
  const chart = speakerReadinessChart(summarizeSpeakerReadiness(cohort, cohort))!;
  assert.equal(chart.bars.length, 1);
  assert.equal(drawn(chart, 0), 100);
  assert.deepEqual(chart.bars[0]!.segments.map((segment) => segment.width), [25, 25, 50]);
  assert.equal(chart.bars[0]!.value, "4");
  assert.equal(chart.bars[0]!.note, "25%");
  assertInsideTrack(chart);
});

test("the composition bar is the one chart with a counted legend", () => {
  const cohort = [speaker({ userId: "a" }), speaker({ userId: "b", onboardingComplete: false })];
  const chart = speakerReadinessChart(summarizeSpeakerReadiness(cohort, cohort))!;
  assert.deepEqual(chart.legend, [
    { key: "ready", label: "Ready", tone: "strong", value: "1" },
    { key: "onboarding", label: "Onboarding open", tone: "alert-soft", value: "0" },
    { key: "profile", label: "Profile incomplete", tone: "dim", value: "1" },
  ]);
  // A bucket nobody is in draws nothing, but keeps its legend entry and its 0.
  assert.deepEqual(chart.bars[0]!.segments.map((segment) => segment.key), ["ready", "profile"]);
  assert.match(chart.ariaLabel, /2 confirmed speakers/);
});

test("a cohort of nobody gets no bar", () => {
  assert.equal(speakerReadinessChart(summarizeSpeakerReadiness([], [])), null);
  // Speakers on the roster but not on a talk are outside the cohort, so there
  // is still nothing to compose — the section's note reports them instead.
  const waiting = [speaker({ userId: "a", sessionCount: 0, scheduledCount: 0, sessionTitles: [] })];
  assert.equal(speakerReadinessChart(summarizeSpeakerReadiness(waiting, [])), null);
});
