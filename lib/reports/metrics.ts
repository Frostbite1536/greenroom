/**
 * Pure projections behind `/admin/reports`.
 *
 * The dashboard at `/admin` answers "where does my programme stand". This page
 * answers a different question — "how did the process perform" — so the folds
 * are new, but the *definitions* are not. Everywhere an existing surface already
 * decides something (which proposals count, when a review is outstanding, what
 * makes a speaker ready), that decision is imported or restated verbatim with a
 * comment naming its owner. Where no fold existed (per-category acceptance,
 * room-day utilization) the rule is written down here once, in a function that
 * takes its inputs and touches neither Prisma, the clock, nor `next/navigation`.
 */
import type { AbstractStatus } from "@prisma/client";
import {
  ABSTRACT_FUNNEL_STATUSES,
  ABSTRACT_STATUS_META,
  ABSTRACT_STATUS_TABS,
} from "@/lib/abstract-status";
import type { SpeakerStatusRow } from "@/lib/speakers/status";
import { zonedParts } from "@/lib/tz";

// ---- 1. Per-category funnel ------------------------------------------------

export type CategoryStatusCount = {
  categoryId: string | null;
  status: AbstractStatus;
  _count: { _all: number };
};

/**
 * The statuses an organizer decision actually settles.
 *
 * Grounded in `lib/services/abstract-decision.ts`: `decisionTimestamp()` stamps
 * `decidedAt` for ACCEPTED and REJECTED and returns null for MAYBE, whose own
 * comment there reads "MAYBE is a review state, not a final programme
 * decision". So a maybe is undecided, and a withdrawal is the speaker's act,
 * not the committee's — neither belongs in an acceptance denominator.
 */
export const DECIDED_STATUSES: readonly AbstractStatus[] = ["ACCEPTED", "REJECTED"];

const CHIP_LABELS = new Map(ABSTRACT_STATUS_TABS.map((tab) => [tab.key, tab.label]));

/** The chip vocabulary `/admin/abstracts` owns, as this report's column heads. */
export const FUNNEL_COLUMNS = ABSTRACT_FUNNEL_STATUSES.map((status) => ({
  status,
  label: CHIP_LABELS.get(status) ?? ABSTRACT_STATUS_META[status].label,
}));

export type CategoryFunnelRow = {
  /** Null is the real "no category" bucket, not a missing row. */
  categoryId: string | null;
  categoryName: string;
  counts: Record<AbstractStatus, number>;
  /** Every proposal in this category, drafts included. */
  total: number;
  /** Proposals that have left DRAFT — `summarizeAbstractFunnel`'s own rule. */
  submitted: number;
  /** ACCEPTED + REJECTED: the proposals the committee has actually settled. */
  decided: number;
  accepted: number;
  /**
   * `accepted / decided`, or null when nothing is decided yet. Null rather than
   * 0 on purpose: "no decisions taken" is not "we accept nobody", and a 0%
   * printed against an open call is a finding an organizer would act on.
   */
  acceptanceRate: number | null;
};

export type CategoryFunnel = {
  rows: CategoryFunnelRow[];
  /** Column-wise totals, so the table's foot cannot disagree with its body. */
  totals: CategoryFunnelRow;
};

function emptyCounts(): Record<AbstractStatus, number> {
  const counts = {} as Record<AbstractStatus, number>;
  for (const status of ABSTRACT_FUNNEL_STATUSES) counts[status] = 0;
  return counts;
}

function finish(
  categoryId: string | null,
  categoryName: string,
  counts: Record<AbstractStatus, number>,
): CategoryFunnelRow {
  const total = ABSTRACT_FUNNEL_STATUSES.reduce((sum, status) => sum + counts[status], 0);
  const decided = DECIDED_STATUSES.reduce((sum, status) => sum + counts[status], 0);
  const accepted = counts.ACCEPTED;
  return {
    categoryId,
    categoryName,
    counts,
    total,
    submitted: total - counts.DRAFT,
    decided,
    accepted,
    acceptanceRate: decided === 0 ? null : accepted / decided,
  };
}

/**
 * Submissions by category and status, from a `groupBy(["categoryId","status"])`
 * over the SAME `adminAbstractListWhere` the abstracts table and the `/admin`
 * funnel count from — so the report's column sums equal the dashboard's funnel
 * segments for the same event.
 *
 * Every supplied category gets a row even with zero proposals (an untouched
 * topic is information), and proposals whose category was deleted, or which
 * never had one, land in one explicit uncategorized row rather than vanishing.
 * Rows keep the category order the caller read them in; the uncategorized row
 * sorts last because it is not a topic anyone chose.
 */
export function summarizeCategoryFunnel(
  groups: readonly CategoryStatusCount[],
  categories: readonly { id: string; name: string }[],
  uncategorizedLabel = "No category",
): CategoryFunnel {
  const byCategory = new Map<string | null, Record<AbstractStatus, number>>();
  for (const category of categories) byCategory.set(category.id, emptyCounts());

  const names = new Map(categories.map((category) => [category.id, category.name]));
  for (const group of groups) {
    // A row whose category no longer exists is uncategorized for this report,
    // exactly as `/admin/abstracts` renders it.
    const key = group.categoryId !== null && names.has(group.categoryId) ? group.categoryId : null;
    const counts = byCategory.get(key) ?? emptyCounts();
    counts[group.status] += group._count._all;
    byCategory.set(key, counts);
  }

  const rows: CategoryFunnelRow[] = [];
  for (const category of categories) {
    rows.push(finish(category.id, category.name, byCategory.get(category.id) ?? emptyCounts()));
  }
  const uncategorized = byCategory.get(null);
  if (uncategorized) rows.push(finish(null, uncategorizedLabel, uncategorized));

  const totals = emptyCounts();
  for (const row of rows) {
    for (const status of ABSTRACT_FUNNEL_STATUSES) totals[status] += row.counts[status];
  }
  return { rows, totals: finish(null, "All categories", totals) };
}

/** One percentage vocabulary for this page: "62%", or an honest dash. */
export function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

// ---- 2. Review load per evaluator ------------------------------------------

export type EvaluatorAssignmentGroup = {
  evaluatorId: string;
  status: string;
  _count: { _all: number };
};

/**
 * One reviewer's workload. Deliberately three numbers and a name.
 *
 * The blind-review boundary this respects is the same one
 * `lib/services/decision-export-csv.ts` models: an evaluator may be counted,
 * never linked. There is no abstract id, no title, and no score on this type,
 * so no rendering of it can reveal who reviewed what or what they thought.
 * `/admin/evaluations` already shows an organizer each reviewer's assignment
 * volume (`loadByPlan`), so this widens nothing — it only adds the completion
 * split an operator otherwise has to count by hand.
 */
export type EvaluatorLoadRow = {
  userId: string;
  name: string;
  assigned: number;
  completed: number;
  /** Assigned reviews not yet completed. Declined assignments are counted
   *  outstanding: a decline is work still needing a reviewer, not work done. */
  outstanding: number;
  /** `completed / assigned`, or null when nothing is assigned. */
  completionRate: number | null;
};

export type ReviewLoad = {
  rows: EvaluatorLoadRow[];
  assigned: number;
  completed: number;
  outstanding: number;
};

/**
 * Per-evaluator assigned/completed/outstanding.
 *
 * The caller supplies groups already filtered to non-withdrawn proposals — the
 * identical exclusion `getEvaluationSetup`'s own `byEvaluator` groupBy applies
 * and `summarizeRoundTotals` applies in JS, because withdrawn work can no
 * longer be scored and would pin a finished reviewer below 100% forever.
 *
 * Members with no assignment at all still get a row: "this reviewer was given
 * nothing" is the finding an operator most needs from a load report, and a
 * disappearing row hides it.
 *
 * Sorted most-outstanding first, then by name — an operator chases the list
 * top-down, exactly as the speaker roster is ordered.
 */
export function summarizeReviewLoad(
  groups: readonly EvaluatorAssignmentGroup[],
  evaluators: readonly { userId: string; name: string }[],
): ReviewLoad {
  const totals = new Map<string, { assigned: number; completed: number }>();
  for (const group of groups) {
    const row = totals.get(group.evaluatorId) ?? { assigned: 0, completed: 0 };
    row.assigned += group._count._all;
    if (group.status === "COMPLETED") row.completed += group._count._all;
    totals.set(group.evaluatorId, row);
  }

  const rows = evaluators.map((evaluator) => {
    const row = totals.get(evaluator.userId) ?? { assigned: 0, completed: 0 };
    return {
      userId: evaluator.userId,
      name: evaluator.name,
      assigned: row.assigned,
      completed: row.completed,
      outstanding: Math.max(0, row.assigned - row.completed),
      completionRate: row.assigned === 0 ? null : row.completed / row.assigned,
    };
  });
  rows.sort((left, right) =>
    right.outstanding - left.outstanding || left.name.localeCompare(right.name));

  return {
    rows,
    assigned: rows.reduce((sum, row) => sum + row.assigned, 0),
    completed: rows.reduce((sum, row) => sum + row.completed, 0),
    outstanding: rows.reduce((sum, row) => sum + row.outstanding, 0),
  };
}

// ---- 3. Schedule utilization -----------------------------------------------

export type UtilizationSlot = {
  roomId: string;
  startsAt: string;
  endsAt: string;
};

export type RoomDayUtilization = {
  roomId: string;
  roomName: string;
  slots: number;
  bookedMinutes: number;
  /** `bookedMinutes / spanMinutes`, or null on a day with no programme. */
  utilization: number | null;
};

export type DayUtilization = {
  /** Event-local `YYYY-MM-DD`, from `zonedParts` — the agenda's own day key. */
  dateKey: string;
  /** Earliest slot start on this day, event-local minutes past midnight. */
  startMinutes: number | null;
  endMinutes: number | null;
  /** The day's programme span: last end minus first start, across all rooms. */
  spanMinutes: number;
  slots: number;
  bookedMinutes: number;
  rooms: RoomDayUtilization[];
};

/**
 * Minutes booked per room per event-local day, against the day's own span.
 *
 * Two definitions are chosen here because nothing existed to borrow, and both
 * could reasonably have gone the other way:
 *
 * 1. **Booked minutes come from the SLOT interval** (`endsAt - startsAt`), not
 *    from `Session.durationMinutes`. A room is occupied for as long as it is
 *    booked; the session's nominal duration is what the proposal asked for and
 *    the two legitimately differ once an organizer stretches a placement.
 *    Utilization is a question about the room, so the slot wins.
 * 2. **The denominator is the day's programme span** — first start to last end
 *    across every room that day — not a fixed working day and not the event's
 *    stored bounds. It is the only window the data itself defines, and it makes
 *    the number answer the question an organizer is really asking: while the
 *    conference was running, how much of that time was this room in use?
 *    A consequence worth naming: the busiest room on a day frequently reads
 *    100%, because it is the one that defines the span.
 *
 * Days are the caller's `eventDayKeys` unioned with every day actually holding
 * a slot, so a placement outside the stored event range is never invisible.
 * Every room gets a row on every day, including zeroes: an idle room is the
 * finding. A slot with a non-positive or unparsable interval contributes zero
 * minutes but is still counted as placed, rather than being silently dropped.
 */
export function summarizeScheduleUtilization(
  slots: readonly UtilizationSlot[],
  rooms: readonly { id: string; name: string }[],
  eventDayKeys: readonly string[],
  timeZone: string,
): DayUtilization[] {
  const days = new Map<string, { starts: number[]; ends: number[]; byRoom: Map<string, { slots: number; minutes: number }> }>();
  const day = (key: string) => {
    let entry = days.get(key);
    if (!entry) {
      entry = { starts: [], ends: [], byRoom: new Map() };
      days.set(key, entry);
    }
    return entry;
  };
  for (const key of eventDayKeys) day(key);

  for (const slot of slots) {
    const start = zonedParts(slot.startsAt, timeZone);
    const entry = day(start.dateKey);
    const minutes = Math.max(0, Math.round(
      (new Date(slot.endsAt).getTime() - new Date(slot.startsAt).getTime()) / 60_000,
    ));
    const safeMinutes = Number.isFinite(minutes) ? minutes : 0;
    entry.starts.push(start.minutesOfDay);
    // A slot ending after midnight would read as a small minutes-of-day and
    // shrink the span, so the end is derived from the start plus its length.
    entry.ends.push(start.minutesOfDay + safeMinutes);
    const room = entry.byRoom.get(slot.roomId) ?? { slots: 0, minutes: 0 };
    room.slots += 1;
    room.minutes += safeMinutes;
    entry.byRoom.set(slot.roomId, room);
  }

  return [...days.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([dateKey, entry]) => {
      const startMinutes = entry.starts.length === 0 ? null : Math.min(...entry.starts);
      const endMinutes = entry.ends.length === 0 ? null : Math.max(...entry.ends);
      const spanMinutes = startMinutes === null || endMinutes === null ? 0 : endMinutes - startMinutes;
      const roomRows = rooms.map((room) => {
        const booked = entry.byRoom.get(room.id) ?? { slots: 0, minutes: 0 };
        return {
          roomId: room.id,
          roomName: room.name,
          slots: booked.slots,
          bookedMinutes: booked.minutes,
          utilization: spanMinutes <= 0 ? null : booked.minutes / spanMinutes,
        };
      });
      return {
        dateKey,
        startMinutes,
        endMinutes,
        spanMinutes,
        slots: roomRows.reduce((sum, room) => sum + room.slots, 0),
        bookedMinutes: roomRows.reduce((sum, room) => sum + room.bookedMinutes, 0),
        rooms: roomRows,
      };
    });
}

/** "6h 30m", "45m", "—". One duration vocabulary for the whole page. */
export function formatMinutes(minutes: number): string {
  if (minutes <= 0) return "—";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

// ---- 4. Speaker readiness distribution -------------------------------------

/**
 * The readiness ladder, in the order `/admin/speakers` renders its pills.
 *
 * The rules are NOT restated here — `onboardingComplete` and
 * `requiredOutstanding` are computed by `lib/speakers/status.ts` and read
 * verbatim, so a speaker who shows "Ready" on the roster is counted Ready here.
 * The ladder is exclusive and exhaustive in that order, which is what makes the
 * three buckets sum to the cohort.
 */
export const SPEAKER_READINESS_BUCKETS = [
  { key: "ready", label: "Ready", tone: "good" },
  { key: "onboarding", label: "Onboarding open", tone: "warn" },
  { key: "profile", label: "Profile incomplete", tone: "info" },
] as const;

export type SpeakerReadinessKey = (typeof SPEAKER_READINESS_BUCKETS)[number]["key"];

export function speakerReadiness(row: SpeakerStatusRow): SpeakerReadinessKey {
  if (row.onboardingComplete) return "ready";
  return row.requiredOutstanding.length > 0 ? "onboarding" : "profile";
}

export type SpeakerReadiness = {
  /** The confirmed-session cohort the roster's headline metrics describe. */
  cohort: number;
  buckets: { key: SpeakerReadinessKey; label: string; tone: string; count: number }[];
  /** Confirmation state across the WHOLE roster, cohort or not. */
  confirmation: { status: "CONFIRMED" | "INVITED" | "DECLINED"; count: number }[];
  /** Roster members not on a session, and therefore outside the cohort. */
  awaitingSession: number;
  /** Cohort speakers holding at least one required task past its deadline. */
  overdue: number;
  /** Sessions held by cohort speakers that hold no slot — the roster's own. */
  unscheduledSessions: number;
};

/**
 * The readiness distribution, measured over the same confirmed-session cohort
 * `/admin/speakers` and the `/admin` dashboard card measure onboarding over —
 * `rows.filter((row) => row.sessionCount > 0)`, which `readSpeakerRoster`
 * already computes as `confirmed`. Speakers not yet on a session are reported
 * separately rather than folded in, exactly as the dashboard reports them.
 */
export function summarizeSpeakerReadiness(
  all: readonly SpeakerStatusRow[],
  cohort: readonly SpeakerStatusRow[],
): SpeakerReadiness {
  const counts = new Map<SpeakerReadinessKey, number>();
  for (const row of cohort) {
    const key = speakerReadiness(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const confirmationCounts = new Map<string, number>();
  for (const row of all) confirmationCounts.set(row.status, (confirmationCounts.get(row.status) ?? 0) + 1);

  return {
    cohort: cohort.length,
    buckets: SPEAKER_READINESS_BUCKETS.map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      tone: bucket.tone,
      count: counts.get(bucket.key) ?? 0,
    })),
    confirmation: (["CONFIRMED", "INVITED", "DECLINED"] as const).map((status) => ({
      status,
      count: confirmationCounts.get(status) ?? 0,
    })),
    awaitingSession: all.length - cohort.length,
    overdue: cohort.filter((row) => row.overdueRequired > 0).length,
    unscheduledSessions: cohort.reduce((sum, row) => sum + (row.sessionCount - row.scheduledCount), 0),
  };
}
