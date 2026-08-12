/**
 * The drawing geometry behind `/admin/reports`.
 *
 * `metrics.ts` decides what the numbers ARE; this file decides only where they
 * land on a track. Nothing here reads Prisma, the clock, or a request — a
 * builder takes one fold's output and returns rectangles, so the charts are
 * unit-tested against the same fixtures the folds are, and `report-charts.tsx`
 * stays a map from this model onto `<rect>` elements.
 *
 * Three rules the whole module obeys, because they are the ones that make a
 * chart lie if they are broken:
 *
 * 1. **A zero never grows a bar and a nonzero never vanishes.** Values are
 *    proportional to the row scale, except that any nonzero value gets at least
 *    `MIN_SEGMENT` of the track so a single proposal in a 400-proposal call is
 *    still visible — and the real figure is always printed beside the bar, so
 *    the floor exaggerates a pixel, never a number.
 * 2. **An empty fold gets no chart.** Every builder returns `null` rather than a
 *    row of empty tracks, and the page renders its existing `EmptyState`
 *    instead. A wall of zero-bars is a fabricated finding.
 * 3. **The bar is the enhancement; the table is the truth.** Bars carry no
 *    axis and no gridlines — the value is direct-labelled — and every chart
 *    hands accessibility one summarizing `aria-label`, because the precise
 *    figures are in the table directly below it.
 *
 * Widths are percentages of the track, so the component can hand the SVG a
 * `viewBox` of `0 0 100 h` and let it scale to whatever the card is wide.
 */
import type { AbstractStatus } from "@prisma/client";
import {
  FUNNEL_COLUMNS,
  formatMinutes,
  formatRate,
  type CategoryFunnel,
  type DayUtilization,
  type ReviewLoad,
  type SubmissionPacing,
  type SpeakerReadiness,
} from "@/lib/reports/metrics";

/** One drawn rectangle. `x` and `width` are percentages of the track. */
export type ChartSegment = {
  key: string;
  /** The series this segment belongs to, as the legend names it. */
  label: string;
  value: number;
  /** Palette key; the component renders it as a class whose fill is a token. */
  tone: ChartTone;
  x: number;
  width: number;
  /** "Accepted: 12" — the hover title, the one place a segment names itself. */
  title: string;
};

/** One row: a name, its rectangles, and the value printed beside them. */
export type ChartBar = {
  key: string;
  /** The full name, always available as a `title` when it was shortened. */
  label: string;
  display: string;
  truncated: boolean;
  segments: ChartSegment[];
  /** The direct label. Never a legend's job to carry this. */
  value: string;
  /** A secondary direct label — a rate beside a count — or null. */
  note: string | null;
};

export type ChartLegendItem = {
  key: string;
  label: string;
  tone: ChartTone;
  /** Only the composition bar's legend carries counts; elsewhere null. */
  value: string | null;
};

export type BarChart = {
  bars: ChartBar[];
  /** Empty unless segments share a track and no direct label can fit. */
  legend: ChartLegendItem[];
  ariaLabel: string;
};

/**
 * The palette, as keys rather than colours.
 *
 * One brand ramp for progress through a process, one accent for the outcome
 * that needs attention, one muted pair for states nobody acted on. The actual
 * values are `--chart-*` custom properties in `globals.css`, each mixed from
 * `--brand`, `--accent` or `--muted`, so a theme change moves the charts too
 * and no hex is written twice.
 */
export type ChartTone =
  | "strong"
  | "mid"
  | "soft"
  | "alert"
  | "alert-soft"
  | "dim"
  | "faint";

/** Longer names are shortened; the component keeps the full one as a `title`. */
const LABEL_MAX = 24;

/**
 * The smallest slice of a track a nonzero value may occupy, in percent.
 *
 * Below roughly this, a segment rounds away to nothing on a phone and the chart
 * reads as "none" where the table reads "1".
 */
const MIN_SEGMENT = 1.2;

function truncate(label: string): { display: string; truncated: boolean } {
  if (label.length <= LABEL_MAX) return { display: label, truncated: false };
  return { display: `${label.slice(0, LABEL_MAX - 1).trimEnd()}…`, truncated: true };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Segment widths for one bar, in percent of the track.
 *
 * Proportional to `scale`, with `MIN_SEGMENT` as the floor for anything
 * nonzero. Raising a hairline to the floor can push the widest row past a full
 * track, so the excess is taken back proportionally from the segments that have
 * room above the floor — the widest segment gives up the most, and no segment
 * is pushed back under the floor it was just given.
 */
function widths(values: readonly number[], scale: number): number[] {
  if (scale <= 0) return values.map(() => 0);
  const raw = values.map((value) =>
    value <= 0 ? 0 : Math.max(MIN_SEGMENT, (value / scale) * 100));
  const total = raw.reduce((sum, width) => sum + width, 0);
  if (total <= 100) return raw;
  const room = raw.reduce((sum, width) => sum + Math.max(0, width - MIN_SEGMENT), 0);
  if (room <= 0) return raw;
  const excess = total - 100;
  return raw.map((width) =>
    width <= MIN_SEGMENT ? width : width - (Math.max(0, width - MIN_SEGMENT) / room) * excess);
}

/**
 * Widths are rounded DOWN to a thousandth of a track before they are written.
 *
 * A percentage carried to seventeen digits is noise in the server's HTML, and
 * rounding down rather than to nearest keeps the invariant that a full bar
 * cannot end past its own track. A thousandth of a track is well under a pixel
 * at any width this page renders at.
 */
function round(width: number): number {
  return Math.floor(width * 1000) / 1000;
}

/**
 * A segment's start, to the same thousandth.
 *
 * Rounded to nearest rather than down, because an offset is the running total
 * of widths that were already floored — flooring it again would open a hairline
 * gap between two segments that are meant to touch.
 */
function roundOffset(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Lay a row's values out left to right, dropping the ones that draw nothing. */
function stack(
  parts: readonly { key: string; label: string; value: number; tone: ChartTone }[],
  scale: number,
): ChartSegment[] {
  const sizes = widths(parts.map((part) => part.value), scale);
  const segments: ChartSegment[] = [];
  let x = 0;
  for (const [index, part] of parts.entries()) {
    const width = round(sizes[index] ?? 0);
    if (width <= 0) continue;
    segments.push({
      key: part.key,
      label: part.label,
      value: part.value,
      tone: part.tone,
      x: roundOffset(x),
      width,
      title: `${part.label}: ${part.value}`,
    });
    x += width;
  }
  return segments;
}

// ---- 0. Submission pacing -------------------------------------------------

export function submissionPacingChart(
  pacing: SubmissionPacing,
  truncated = pacing.rangeTruncated,
): BarChart | null {
  if (pacing.rows.length === 0 || pacing.peak <= 0) return null;
  const bars = pacing.rows.map((row) => ({
    key: row.dateKey,
    label: row.dateKey,
    display: row.dateKey,
    truncated: false,
    segments: stack(
      [{ key: "submitted", label: "Submitted", value: row.submitted, tone: "strong" }],
      pacing.peak,
    ),
    value: String(row.submitted),
    note: `${row.cumulative} total`,
  }));
  return {
    bars,
    legend: [],
    ariaLabel:
      `Bar chart of submission pacing across ${plural(bars.length, "day", "days")}: ` +
      `${truncated ? "at least " : ""}${plural(pacing.total, "proposal", "proposals")} submitted` +
      `${truncated ? " in the bounded window" : ""}. The table below lists every visible figure.`,
  };
}

// ---- 1. Per-category funnel ------------------------------------------------

/**
 * The funnel's own chip order, coloured as a journey: a proposal warms from a
 * faint draft through the brand ramp to an accepted talk, a declined one takes
 * the accent, and the two states nobody decided sit muted. Exhaustive over
 * `AbstractStatus` by construction, so a new status cannot be added to the
 * schema without this map failing to compile.
 */
const STATUS_TONES = {
  DRAFT: "faint",
  SUBMITTED: "soft",
  UNDER_REVIEW: "mid",
  MAYBE: "alert-soft",
  ACCEPTED: "strong",
  REJECTED: "alert",
  WITHDRAWN: "dim",
} satisfies Record<AbstractStatus, ChartTone>;

/**
 * One stacked bar per category, scaled against the biggest category.
 *
 * Stacked rather than grouped because the question the section asks is about
 * composition — how much of this topic got through — and seven grouped bars per
 * row would be unreadable at a phone's width. Bars are scaled against the
 * largest category rather than each normalized to 100%, so a large topic looks
 * large; the acceptance rate is printed beside each bar for the proportion.
 *
 * A category with no proposals keeps its row and draws an empty track: the fold
 * emits that row deliberately ("an untouched topic is information") and hiding
 * it here would contradict the table.
 */
export function categoryFunnelChart(funnel: CategoryFunnel): BarChart | null {
  if (funnel.rows.length === 0 || funnel.totals.total <= 0) return null;
  const scale = Math.max(...funnel.rows.map((row) => row.total));
  if (scale <= 0) return null;

  const bars = funnel.rows.map((row) => {
    const { display, truncated } = truncate(row.categoryName);
    return {
      key: row.categoryId ?? "uncategorized",
      label: row.categoryName,
      display,
      truncated,
      segments: stack(
        FUNNEL_COLUMNS.map((column) => ({
          key: column.status,
          label: column.label,
          value: row.counts[column.status],
          tone: STATUS_TONES[column.status],
        })),
        scale,
      ),
      value: String(row.total),
      note: formatRate(row.acceptanceRate),
    };
  });

  // Only the statuses this event actually has; a legend key for a status nobody
  // used is a colour an organizer hunts for and never finds.
  const legend = FUNNEL_COLUMNS
    .filter((column) => funnel.totals.counts[column.status] > 0)
    .map((column) => ({
      key: column.status,
      label: column.label,
      tone: STATUS_TONES[column.status],
      value: null,
    }));

  return {
    bars,
    legend,
    ariaLabel:
      `Stacked bar chart of proposals by category: ${plural(bars.length, "category", "categories")}, ` +
      `${plural(funnel.totals.total, "proposal", "proposals")} in total, ` +
      `${formatRate(funnel.totals.acceptanceRate)} accepted overall. ` +
      `Bar length is the category's proposal count; the table below lists every figure.`,
  };
}

// ---- 2. Review load per evaluator ------------------------------------------

/**
 * One bar per reviewer, completed then outstanding, scaled against the largest
 * assignment so the bars compare workloads rather than each reading full.
 *
 * The fold's sort — most outstanding first — is kept, so the chart is read
 * top-down exactly like the table beside it. A reviewer with nothing assigned
 * keeps an empty row: that is the finding the fold exists to surface.
 */
export function reviewLoadChart(review: ReviewLoad): BarChart | null {
  if (review.rows.length === 0 || review.assigned <= 0) return null;
  const scale = Math.max(...review.rows.map((row) => row.assigned));
  if (scale <= 0) return null;

  const bars = review.rows.map((row) => {
    const { display, truncated } = truncate(row.name);
    return {
      key: row.userId,
      label: row.name,
      display,
      truncated,
      segments: stack(
        [
          { key: "completed", label: "Completed", value: row.completed, tone: "strong" as const },
          { key: "outstanding", label: "Outstanding", value: row.outstanding, tone: "alert-soft" as const },
        ],
        scale,
      ),
      value: row.assigned === 0 ? "—" : `${row.completed} / ${row.assigned}`,
      note: row.assigned === 0 ? "Nothing assigned" : formatRate(row.completionRate),
    };
  });

  return {
    bars,
    legend: [
      { key: "completed", label: "Completed", tone: "strong", value: null },
      { key: "outstanding", label: "Outstanding", tone: "alert-soft", value: null },
    ],
    ariaLabel:
      `Bar chart of review load by reviewer: ${plural(bars.length, "reviewer", "reviewers")}, ` +
      `${review.completed} of ${plural(review.assigned, "assigned review", "assigned reviews")} complete, ` +
      `${review.outstanding} outstanding. The table below lists every figure.`,
  };
}

// ---- 3. Schedule utilization -----------------------------------------------

/**
 * One day's rooms against that day's programme span — the same denominator the
 * fold uses, so the bar and the table's percentage cannot disagree.
 *
 * A chart per day rather than one grid: days are what an organizer compares
 * within, the room set repeats, and a day-per-chart keeps each summary
 * `aria-label` about a day an operator can name. A day with no programme span
 * has nothing to measure against and returns null rather than a row of zeroes.
 */
export function scheduleUtilizationChart(day: DayUtilization, dayLabel: string): BarChart | null {
  if (day.rooms.length === 0 || day.spanMinutes <= 0) return null;

  const bars = day.rooms.map((room) => {
    const { display, truncated } = truncate(room.roomName);
    return {
      key: room.roomId,
      label: room.roomName,
      display,
      truncated,
      segments: stack(
        [{ key: "booked", label: "Booked", value: room.bookedMinutes, tone: "strong" as const }],
        day.spanMinutes,
      ),
      value: formatRate(room.utilization),
      note: room.slots === 0 ? "Idle" : formatMinutes(room.bookedMinutes),
    };
  });

  return {
    bars,
    legend: [],
    ariaLabel:
      `Bar chart of room utilization on ${dayLabel}: ${plural(bars.length, "room", "rooms")}, ` +
      `${formatMinutes(day.bookedMinutes)} booked across a ${formatMinutes(day.spanMinutes)} program span. ` +
      `The table below lists every figure.`,
  };
}

// ---- 4. Speaker readiness distribution -------------------------------------

/** The roster's tone words, as this file's palette keys. */
const READINESS_TONES: Record<string, ChartTone> = {
  good: "strong",
  warn: "alert-soft",
  info: "dim",
};

/**
 * The readiness ladder as one 100% composition bar.
 *
 * A single bar, not one per bucket, because the buckets are exclusive and
 * exhaustive over the cohort — the question is what share is ready, and a
 * composition bar answers it in one line. Not a pie: three slices at these
 * sizes are compared far more accurately along a common baseline, and a pie
 * costs an angle-to-value step the reader has to do by eye.
 *
 * This is the one chart whose segments cannot be direct-labelled — the narrow
 * ones have no room — so it is the one chart that gets a legend, and the legend
 * carries the counts rather than just the colours.
 */
export function speakerReadinessChart(readiness: SpeakerReadiness): BarChart | null {
  if (readiness.cohort <= 0) return null;
  const parts = readiness.buckets.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    value: bucket.count,
    tone: READINESS_TONES[bucket.tone] ?? "dim",
  }));

  const ready = readiness.buckets.find((bucket) => bucket.key === "ready")?.count ?? 0;
  return {
    bars: [
      {
        key: "cohort",
        label: "Confirmed-session cohort",
        display: "Confirmed-session cohort",
        truncated: false,
        // Scaled to the cohort, so the three segments fill exactly one track.
        segments: stack(parts, readiness.cohort),
        value: String(readiness.cohort),
        note: formatRate(ready / readiness.cohort),
      },
    ],
    legend: parts.map((part) => ({
      key: part.key,
      label: part.label,
      tone: part.tone,
      value: String(part.value),
    })),
    ariaLabel:
      `Stacked composition bar of speaker readiness across ` +
      `${plural(readiness.cohort, "confirmed speaker", "confirmed speakers")}: ` +
      `${parts.map((part) => `${part.value} ${part.label.toLowerCase()}`).join(", ")}. ` +
      `The list below repeats every figure.`,
  };
}
