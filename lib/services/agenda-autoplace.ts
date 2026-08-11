import { createHash } from "node:crypto";
import { DEFAULT_GRID_END, DEFAULT_GRID_START } from "@/lib/agenda-layout";
import { minutesToTimeInput, zonedParts, zonedToUtcIso } from "@/lib/tz";
import { detectConflicts, type CandidateSlot, type SlotInterval } from "@/lib/services/schedule";

/**
 * Pure placement planner for "Fill open slots" (AIA-08, addendum §4.1).
 *
 * Everything here is a total function of one snapshot: no Prisma, no clock, no
 * randomness. The preview route computes a plan with it and writes nothing; the
 * apply route recomputes the *same* function against a freshly re-read snapshot
 * under the schedule locks and refuses the write unless it still agrees. That
 * only works because the planner is deterministic, so determinism is the
 * contract this module is tested against rather than a nice property.
 *
 * What it is NOT: an optimizer. It fills the earliest openings first with the
 * lowest stable session ID that fits, and reports anything left over. A greedy
 * pass can leave a session unplaced that a smarter search would have fitted;
 * that outcome is surfaced as `NO_FREE_SLOT`, never hidden.
 */

/**
 * The programme window auto-placement will propose inside, in event-local
 * minutes from midnight. Shared with the builder's default grid so a proposal
 * always lands somewhere the operator can actually see it. Existing placements
 * outside the window are never moved and are still conflict-checked; the
 * planner simply does not invent a 07:00 or a 22:00 slot on its own.
 */
export const PLACEMENT_WINDOW_START_MINUTE = DEFAULT_GRID_START;
export const PLACEMENT_WINDOW_END_MINUTE = DEFAULT_GRID_END;

/**
 * Candidate start times sit on quarter-hour marks. 15 is a multiple of the
 * 5-minute lattice drag-and-drop snaps to, so every proposal is a position an
 * operator could also have produced by hand — and a tidier one than packing
 * flush against a talk that happened to end at 09:47.
 */
export const PLACEMENT_STEP_MINUTES = 15;

/** Longest talk the scheduler dialog accepts; anything longer is bad data. */
export const PLACEMENT_MAX_DURATION_MINUTES = 480;

/**
 * Days considered in one plan. Event days are derived from real data (see
 * `placementDayKeys`), which an unusual event could make unbounded; the planner
 * refuses to turn that into an unbounded search.
 */
export const PLACEMENT_MAX_DAYS = 14;

/** A bookable room. `sortOrder` is the operator's own column ordering. */
export type PlannerRoom = { id: string; sortOrder: number };

/** An existing placement. Times are epoch ms, as in `lib/services/schedule`. */
export type PlannerSlot = {
  slotId: string;
  sessionId: string;
  roomId: string;
  startsAt: number;
  endsAt: number;
  speakerIds: string[];
};

/** An unscheduled session competing for an opening. */
export type PlannerSession = {
  id: string;
  title: string;
  durationMinutes: number;
  speakerIds: string[];
};

export type PlacementSnapshot = {
  eventId: string;
  timezone: string;
  /** Every room in the event. Order here is irrelevant; the planner sorts. */
  rooms: PlannerRoom[];
  /** Every existing placement in the event. All of these stay exactly put. */
  existingSlots: PlannerSlot[];
  /** Eligible unscheduled sessions (see `eligibleForPlacement`). */
  unscheduled: PlannerSession[];
  /**
   * Event-local day keys (`YYYY-MM-DD`) to consider in addition to the days the
   * existing placements already occupy — normally the event's own date range,
   * which is the only source of days when nothing is scheduled yet.
   */
  eventDayKeys?: string[];
};

export type ProposedPlacement = {
  sessionId: string;
  title: string;
  roomId: string;
  /** Event-local day this lands on, for display and for revalidation. */
  dayKey: string;
  /** Event-local minutes from midnight, for display and for revalidation. */
  startMinute: number;
  durationMinutes: number;
  startsAt: string;
  endsAt: string;
};

export type UnplaceableReason =
  | "NO_ROOMS"
  | "NO_EVENT_DAYS"
  | "INVALID_DURATION"
  | "NO_FREE_SLOT";

export type UnplaceableSession = {
  sessionId: string;
  title: string;
  reason: UnplaceableReason;
  /** Plain-language explanation shown to the operator. Never omitted. */
  message: string;
};

export type PlacementPlan = {
  placements: ProposedPlacement[];
  /** Every eligible session that did not get a placement, with a reason. */
  unplaceable: UnplaceableSession[];
  /** The days the planner actually searched, in ascending order. */
  days: string[];
  window: { startMinute: number; endMinute: number; stepMinutes: number };
};

/** Ordinal (bytewise) comparison; never locale-dependent. */
function byId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unplaceable(
  session: PlannerSession,
  reason: UnplaceableReason,
  message: string,
): UnplaceableSession {
  return { sessionId: session.id, title: session.title, reason, message };
}

/**
 * Eligibility, stated honestly.
 *
 * `Session` is already the post-acceptance surface: a row exists only because
 * an accepted abstract was converted or an organizer authored a talk directly,
 * and the model carries no archived/withdrawn flag. So the only eligibility
 * questions left for placement are the two below.
 *
 * `contentStatus` is deliberately NOT a filter. Publication gating (#77) is a
 * separate, explicit organizer act: an unpublished talk can be laid out on the
 * internal grid exactly as drag-and-drop already allows, and placing it does
 * not publish it. Auto-placement must not become a back door that puts a talk
 * on the public programme.
 */
export function eligibleForPlacement(session: PlannerSession): boolean {
  return (
    Number.isInteger(session.durationMinutes)
    && session.durationMinutes > 0
    && session.durationMinutes <= PLACEMENT_MAX_DURATION_MINUTES
  );
}

/**
 * Event-local day keys covering `[startsAt, endsAt]`, inclusive, capped.
 * Returns `[]` when the event has no usable start, which is the honest answer:
 * an event with no dates and nothing scheduled has nowhere to put a talk.
 */
export function placementDayKeys(
  startsAt: Date | string | null | undefined,
  endsAt: Date | string | null | undefined,
  timeZone: string,
  cap = PLACEMENT_MAX_DAYS,
): string[] {
  const start = startsAt ? new Date(startsAt) : null;
  if (!start || Number.isNaN(start.getTime())) return [];
  const end = endsAt ? new Date(endsAt) : null;
  const last = end && !Number.isNaN(end.getTime()) && end.getTime() >= start.getTime() ? end : start;

  const days: string[] = [];
  const firstKey = zonedParts(start.toISOString(), timeZone).dateKey;
  const lastKey = zonedParts(last.toISOString(), timeZone).dateKey;
  // Step by calendar day at UTC noon: far enough from either midnight that no
  // DST shift can skip or repeat a day key.
  let cursor = new Date(`${firstKey}T12:00:00Z`);
  const limit = new Date(`${lastKey}T12:00:00Z`).getTime();
  while (cursor.getTime() <= limit && days.length < cap) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return days;
}

/**
 * Days the plan searches: every day an existing placement already occupies,
 * plus the event's own date range. Sorted ascending and capped, so the search
 * space is a documented function of the snapshot.
 */
function searchDays(snapshot: PlacementSnapshot): string[] {
  const keys = new Set<string>();
  for (const slot of snapshot.existingSlots) {
    keys.add(zonedParts(new Date(slot.startsAt).toISOString(), snapshot.timezone).dateKey);
  }
  for (const key of snapshot.eventDayKeys ?? []) keys.add(key);
  return [...keys].sort(byId).slice(0, PLACEMENT_MAX_DAYS);
}

/**
 * Narrow the comparison set to the slots `detectConflicts` could possibly
 * report on — same room, or a shared speaker. This is an index, not a second
 * conflict rule: `detectConflicts` stays the only authority on what collides,
 * and it can never flag a slot that is neither in this room nor shares a
 * speaker. Without it a large event's search is quadratic in slots.
 */
function relevantIntervals(
  candidate: CandidateSlot,
  byRoom: Map<string, SlotInterval[]>,
  bySpeaker: Map<string, SlotInterval[]>,
): SlotInterval[] {
  const seen = new Set<string>();
  const out: SlotInterval[] = [];
  const push = (slot: SlotInterval) => {
    if (seen.has(slot.slotId)) return;
    seen.add(slot.slotId);
    out.push(slot);
  };
  for (const slot of byRoom.get(candidate.roomId) ?? []) push(slot);
  for (const speakerId of candidate.speakerIds) {
    for (const slot of bySpeaker.get(speakerId) ?? []) push(slot);
  }
  return out;
}

function bucket(map: Map<string, SlotInterval[]>, key: string, slot: SlotInterval): void {
  const existing = map.get(key);
  if (existing) existing.push(slot);
  else map.set(key, [slot]);
}

function index(slots: SlotInterval[]) {
  const byRoom = new Map<string, SlotInterval[]>();
  const bySpeaker = new Map<string, SlotInterval[]>();
  for (const slot of slots) {
    bucket(byRoom, slot.roomId, slot);
    for (const speakerId of slot.speakerIds) bucket(bySpeaker, speakerId, slot);
  }
  return { byRoom, bySpeaker };
}

/**
 * Build the plan.
 *
 * Ordering (addendum §4.1), applied as one total order over candidate
 * placements: event day → candidate start time → room sort order → stable
 * session ID. The loop walks openings in exactly that order and gives each one
 * to the lowest-ID remaining session that fits it, which is what makes two runs
 * over the same snapshot byte-identical.
 *
 * Existing placements are never read as movable and never appear in the output.
 * Proposed placements join the conflict set as they are made, so the plan is
 * internally consistent as well as consistent with what is already scheduled.
 */
export function planOpenSlotPlacements(snapshot: PlacementSnapshot): PlacementPlan {
  const days = searchDays(snapshot);
  const rooms = [...snapshot.rooms].sort(
    (left, right) => left.sortOrder - right.sortOrder || byId(left.id, right.id),
  );
  const window = {
    startMinute: PLACEMENT_WINDOW_START_MINUTE,
    endMinute: PLACEMENT_WINDOW_END_MINUTE,
    stepMinutes: PLACEMENT_STEP_MINUTES,
  };

  const candidates = [...snapshot.unscheduled].sort((left, right) => byId(left.id, right.id));
  const placements: ProposedPlacement[] = [];
  const blocked: UnplaceableSession[] = [];
  const remaining: PlannerSession[] = [];

  for (const session of candidates) {
    if (!eligibleForPlacement(session)) {
      blocked.push(unplaceable(
        session,
        "INVALID_DURATION",
        `This talk's length (${session.durationMinutes} minutes) is not a length the scheduler can place. `
          + "Set a duration between 1 and 480 minutes, then try again.",
      ));
      continue;
    }
    remaining.push(session);
  }

  if (rooms.length === 0) {
    return {
      placements,
      unplaceable: [
        ...blocked,
        ...remaining.map((session) => unplaceable(
          session,
          "NO_ROOMS",
          "This event has no rooms, so there is nowhere to place a talk. Add a room in Settings.",
        )),
      ],
      days,
      window,
    };
  }
  if (days.length === 0) {
    return {
      placements,
      unplaceable: [
        ...blocked,
        ...remaining.map((session) => unplaceable(
          session,
          "NO_EVENT_DAYS",
          "This event has no dates and nothing is scheduled yet, so there is no day to place a talk on. "
            + "Set the event dates in Settings, or place one talk by hand first.",
        )),
      ],
      days,
      window,
    };
  }

  // Existing placements plus proposals accepted so far. `slotId` for a proposal
  // is a synthetic key that exists only inside this pass; it is never persisted.
  const conflictSet: SlotInterval[] = snapshot.existingSlots.map((slot) => ({
    slotId: slot.slotId,
    roomId: slot.roomId,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    speakerIds: slot.speakerIds,
  }));
  const { byRoom, bySpeaker } = index(conflictSet);
  const addToIndex = (slot: SlotInterval) => {
    bucket(byRoom, slot.roomId, slot);
    for (const speakerId of slot.speakerIds) bucket(bySpeaker, speakerId, slot);
  };

  for (const dayKey of days) {
    if (remaining.length === 0) break;
    for (
      let startMinute = window.startMinute;
      startMinute < window.endMinute;
      startMinute += window.stepMinutes
    ) {
      if (remaining.length === 0) break;
      const startsAtIso = zonedToUtcIso(dayKey, minutesToTimeInput(startMinute), snapshot.timezone);
      const startsAt = new Date(startsAtIso).getTime();

      for (const room of rooms) {
        if (remaining.length === 0) break;
        const takenIndex = remaining.findIndex((session) => {
          if (startMinute + session.durationMinutes > window.endMinute) return false;
          const candidate: CandidateSlot = {
            roomId: room.id,
            startsAt,
            endsAt: startsAt + session.durationMinutes * 60_000,
            speakerIds: session.speakerIds,
          };
          return detectConflicts(candidate, relevantIntervals(candidate, byRoom, bySpeaker)).length === 0;
        });
        if (takenIndex === -1) continue;

        const [session] = remaining.splice(takenIndex, 1);
        const endsAt = startsAt + session.durationMinutes * 60_000;
        placements.push({
          sessionId: session.id,
          title: session.title,
          roomId: room.id,
          dayKey,
          startMinute,
          durationMinutes: session.durationMinutes,
          startsAt: startsAtIso,
          endsAt: new Date(endsAt).toISOString(),
        });
        addToIndex({
          slotId: `proposed:${session.id}`,
          roomId: room.id,
          startsAt,
          endsAt,
          speakerIds: session.speakerIds,
        });
      }
    }
  }

  return {
    placements,
    unplaceable: [
      ...blocked,
      ...remaining.map((session) => unplaceable(
        session,
        "NO_FREE_SLOT",
        "No room is free for this talk's whole length inside the program window on any event day. "
          + "Free up time, add a room, or place it by hand.",
      )),
    ].sort((left, right) => byId(left.sessionId, right.sessionId)),
    days,
    window,
  };
}

/**
 * Fingerprint of everything the plan depends on.
 *
 * It is an optimization for stale detection and an audit aid, not an authority:
 * apply re-reads and revalidates every target under the schedule locks whether
 * or not this matches (addendum §4.2). A matching fingerprint therefore proves
 * only that the inputs the planner reads are unchanged.
 */
export function placementSnapshotFingerprint(snapshot: PlacementSnapshot): string {
  const canonical = JSON.stringify({
    v: 1,
    eventId: snapshot.eventId,
    timezone: snapshot.timezone,
    window: [PLACEMENT_WINDOW_START_MINUTE, PLACEMENT_WINDOW_END_MINUTE, PLACEMENT_STEP_MINUTES],
    days: [...(snapshot.eventDayKeys ?? [])].sort(byId),
    rooms: [...snapshot.rooms]
      .sort((left, right) => byId(left.id, right.id))
      .map((room) => [room.id, room.sortOrder]),
    slots: [...snapshot.existingSlots]
      .sort((left, right) => byId(left.slotId, right.slotId))
      .map((slot) => [
        slot.slotId,
        slot.sessionId,
        slot.roomId,
        slot.startsAt,
        slot.endsAt,
        [...slot.speakerIds].sort(byId),
      ]),
    sessions: [...snapshot.unscheduled]
      .sort((left, right) => byId(left.id, right.id))
      .map((session) => [session.id, session.durationMinutes, [...session.speakerIds].sort(byId)]),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}
