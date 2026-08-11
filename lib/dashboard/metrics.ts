/**
 * Pure projections behind the `/admin` dashboard.
 *
 * The dashboard's whole value is that its numbers agree with the screens it
 * links to, so nothing here invents a definition. Each function takes the same
 * rows the linked page already reads and folds them the same way; the folds
 * live here so they are unit-testable without a database and so a change to one
 * screen's definition cannot silently leave the dashboard behind.
 *
 * Nothing in this module touches Prisma, `next/navigation`, or the clock.
 */
import type { AbstractStatus } from "@prisma/client";
import {
  ABSTRACT_FUNNEL_STATUSES,
  ABSTRACT_STATUS_META,
  ABSTRACT_STATUS_TABS,
  abstractStatusFilterHref,
} from "@/lib/abstract-status";

// ---- CFP funnel ------------------------------------------------------------

export type AbstractStatusCount = { status: AbstractStatus; _count: { _all: number } };

export type FunnelSegment = {
  status: AbstractStatus;
  /** The chip's own label on `/admin/abstracts`, so the link is not a rename. */
  label: string;
  tone: string;
  count: number;
  /** `/admin/abstracts?status=…` — the chip this segment counted. */
  href: string;
};

export type AbstractFunnel = {
  segments: FunnelSegment[];
  /** Every proposal, drafts included — the "All" chip's own number. */
  total: number;
  /** Proposals that have left DRAFT: what an organizer means by "submissions". */
  submitted: number;
};

const CHIP_LABELS = new Map(ABSTRACT_STATUS_TABS.map((tab) => [tab.key, tab.label]));

/**
 * The funnel, in chip order, from the same `groupBy(["status"])` rows
 * `getAdminAbstracts` reads for the abstracts page's own metric strip. A status
 * with no rows still gets a segment: "zero declined" is information, and a
 * disappearing row would make the funnel reorder itself as decisions land.
 */
export function summarizeAbstractFunnel(groups: readonly AbstractStatusCount[]): AbstractFunnel {
  const counts = new Map<AbstractStatus, number>();
  for (const group of groups) {
    counts.set(group.status, (counts.get(group.status) ?? 0) + group._count._all);
  }

  const segments = ABSTRACT_FUNNEL_STATUSES.map((status) => ({
    status,
    label: CHIP_LABELS.get(status) ?? ABSTRACT_STATUS_META[status].label,
    tone: ABSTRACT_STATUS_META[status].tone,
    count: counts.get(status) ?? 0,
    href: abstractStatusFilterHref(status),
  }));

  const total = segments.reduce((sum, segment) => sum + segment.count, 0);
  return { segments, total, submitted: total - (counts.get("DRAFT") ?? 0) };
}

// ---- Review progress -------------------------------------------------------

export type ReviewAssignmentGroup = {
  planId: string;
  abstractId: string;
  status: string;
  _count: { _all: number };
};

export type RoundTotals = { assigned: number; completed: number };

/**
 * Assigned and completed review counts per round.
 *
 * Extracted from `getEvaluationSetup` so the evaluations screen and the
 * dashboard card that links to it fold the identical rows identically. The one
 * rule that is easy to get wrong lives here: **a withdrawn proposal's
 * assignments are excluded entirely**, because withdrawn work can no longer be
 * scored and would otherwise pin a finished round below 100% forever.
 */
export function summarizeRoundTotals(
  groups: readonly ReviewAssignmentGroup[],
  isWithdrawn: (abstractId: string) => boolean,
): Map<string, RoundTotals> {
  const planTotals = new Map<string, RoundTotals>();
  for (const row of groups) {
    if (isWithdrawn(row.abstractId)) continue;
    const totals = planTotals.get(row.planId) ?? { assigned: 0, completed: 0 };
    totals.assigned += row._count._all;
    if (row.status === "COMPLETED") totals.completed += row._count._all;
    planTotals.set(row.planId, totals);
  }
  return planTotals;
}

export type ReviewRoundProgress = {
  id: string;
  ordinal: number;
  name: string;
  assigned: number;
  completed: number;
  /** Assigned reviews still to be scored. Never negative. */
  outstanding: number;
};

export type ReviewProgress = {
  rounds: ReviewRoundProgress[];
  assigned: number;
  completed: number;
  outstanding: number;
  /**
   * True when the rounds list hit its read cap — the totals above then cover
   * only the rounds shown, and the card must say so rather than present a
   * truncated list as the whole event.
   */
  truncatedRounds: boolean;
};

export function summarizeReviewProgress(
  plans: readonly { id: string; ordinal: number; name: string }[],
  planTotals: ReadonlyMap<string, RoundTotals>,
  truncatedRounds = false,
): ReviewProgress {
  const rounds = plans.map((plan) => {
    const totals = planTotals.get(plan.id) ?? { assigned: 0, completed: 0 };
    return {
      id: plan.id,
      ordinal: plan.ordinal,
      name: plan.name,
      assigned: totals.assigned,
      completed: totals.completed,
      outstanding: Math.max(0, totals.assigned - totals.completed),
    };
  });
  return {
    rounds,
    assigned: rounds.reduce((sum, round) => sum + round.assigned, 0),
    completed: rounds.reduce((sum, round) => sum + round.completed, 0),
    outstanding: rounds.reduce((sum, round) => sum + round.outstanding, 0),
    truncatedRounds,
  };
}

// ---- Programme health ------------------------------------------------------

export type ProgrammeSession = {
  contentStatus: "DRAFT" | "PUBLISHED";
  slot: { roomId: string } | null;
};

export type ProgrammeHealth = {
  sessions: number;
  /** "Scheduled" means the talk holds a ScheduleSlot — the agenda's own rule. */
  scheduled: number;
  unscheduled: number;
  published: number;
  unpublished: number;
  /** Distinct rooms holding at least one placed talk. */
  roomsInUse: number;
  roomsTotal: number;
  /** Whatever the agenda builder's Conflicts view counts; never recomputed here. */
  conflicts: number;
  /** True when the agenda read was cut, so every figure above is a floor. */
  truncated: boolean;
};

/**
 * `conflicts` is passed in rather than derived: overlap detection belongs to
 * `lib/agenda-conflicts` (`findConflicts`), which is what the Conflicts view
 * itself renders. Reimplementing the interval maths here is exactly the drift
 * this module exists to prevent.
 */
export function summarizeProgrammeHealth(
  sessions: readonly ProgrammeSession[],
  roomsTotal: number,
  conflicts: number,
  truncated: boolean,
): ProgrammeHealth {
  const scheduled = sessions.filter((session) => session.slot !== null).length;
  const published = sessions.filter((session) => session.contentStatus === "PUBLISHED").length;
  const roomsInUse = new Set(
    sessions.flatMap((session) => (session.slot ? [session.slot.roomId] : [])),
  ).size;
  return {
    sessions: sessions.length,
    scheduled,
    unscheduled: sessions.length - scheduled,
    published,
    unpublished: sessions.length - published,
    roomsInUse,
    roomsTotal,
    conflicts,
    truncated,
  };
}
