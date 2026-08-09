/**
 * The room removal policy is intentionally separate from persistence so its
 * user-facing safety contract stays easy to test. The route supplies this
 * function only after it has locked and re-read the room and its slot use in
 * the same transaction.
 */
export type RoomDeletionDecision =
  | { allowed: true }
  | { allowed: false; code: "ROOM_IN_USE"; message: string };

export function decideRoomDeletion(hasScheduleSlot: boolean): RoomDeletionDecision {
  if (hasScheduleSlot) {
    return {
      allowed: false,
      code: "ROOM_IN_USE",
      message: "This room is scheduled. Move or unschedule its sessions before removing it.",
    };
  }
  return { allowed: true };
}
