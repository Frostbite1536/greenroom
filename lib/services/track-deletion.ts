/**
 * The track removal policy is kept separate from persistence so its user-facing
 * safety contract stays easy to test, exactly as `room-deletion.ts` is. The
 * route supplies this function only after it has locked and re-read the scoped
 * track and its slot use in the same transaction.
 *
 * Unlike a Room, a Track owns its `ScheduleSlot` rows with `onDelete: SetNull`,
 * so deleting a used track would not destroy the schedule — it would quietly
 * strip the swimlane off every session on it, on the agenda grid, the public
 * schedule's `?track=` filter, the calendar invites and both mirror pushes,
 * with nothing to tell the organizer which sessions lost their lane. Silent is
 * the problem, not cascade, so a track anyone has scheduled against is refused
 * with a stable code and kept intact.
 */
export type TrackDeletionDecision =
  | { allowed: true }
  | { allowed: false; code: "TRACK_IN_USE"; message: string };

export function decideTrackDeletion(hasScheduleSlot: boolean): TrackDeletionDecision {
  if (hasScheduleSlot) {
    return {
      allowed: false,
      code: "TRACK_IN_USE",
      message: "This track is on the schedule. Move its sessions to another track before removing it.",
    };
  }
  return { allowed: true };
}
