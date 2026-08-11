import type { ScheduleConflict } from "@/types/api";

/**
 * Minimal shape of a placed slot used for conflict detection. Times are epoch
 * milliseconds so the core logic stays pure and trivially testable.
 */
export type SlotInterval = {
  slotId: string;
  roomId: string;
  startsAt: number;
  endsAt: number;
  speakerIds: string[];
};

export type CandidateSlot = {
  /** Present when editing an existing slot; excluded from its own comparison. */
  slotId?: string;
  roomId: string;
  startsAt: number;
  endsAt: number;
  speakerIds: string[];
};

/** Half-open interval overlap: [aStart, aEnd) intersects [bStart, bEnd). */
export function intervalsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Detect room and speaker overlaps for a candidate placement against existing
 * slots (INV-SCHEDULE-001). Returns every conflict found so the UI can explain
 * exactly what collides. The caller performs detection + write in one
 * transaction and refuses the write when this returns a non-empty list.
 */
export function detectConflicts(
  candidate: CandidateSlot,
  existing: SlotInterval[],
): ScheduleConflict[] {
  const conflicts: ScheduleConflict[] = [];
  const candidateSpeakers = new Set(candidate.speakerIds);

  for (const slot of existing) {
    if (candidate.slotId && slot.slotId === candidate.slotId) continue;
    if (!intervalsOverlap(candidate.startsAt, candidate.endsAt, slot.startsAt, slot.endsAt)) {
      continue;
    }

    if (slot.roomId === candidate.roomId) {
      conflicts.push({
        type: "ROOM_OVERLAP",
        slotId: candidate.slotId,
        conflictingSlotId: slot.slotId,
        message: "Room is already booked for an overlapping time.",
      });
    }

    const sharedSpeaker = slot.speakerIds.find((id) => candidateSpeakers.has(id));
    if (sharedSpeaker) {
      conflicts.push({
        type: "SPEAKER_OVERLAP",
        slotId: candidate.slotId,
        conflictingSlotId: slot.slotId,
        message: "A speaker is already scheduled for an overlapping time.",
        // Additive: the id this branch already matched on, carried out so the
        // refusal can name the person instead of saying "a speaker".
        speakerId: sharedSpeaker,
      });
    }
  }

  return conflicts;
}
