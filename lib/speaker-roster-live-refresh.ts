/** The quiet interval for the speaker-readiness dashboard's optional refresh. */
export const SPEAKER_ROSTER_REFRESH_INTERVAL_MS = 20_000;

export type SpeakerRosterRefreshBlockers = {
  paused: boolean;
  hidden: boolean;
  focused: boolean;
  dialogOpen: boolean;
  dirtyEditor: boolean;
  editableFocused: boolean;
  pending: boolean;
};

/**
 * A refresh replaces the server-component payload, so it must never arrive
 * while an organizer could lose text they are editing. Keeping this predicate
 * pure makes every pause reason explicit and independently testable.
 */
export function mayRefreshSpeakerRoster(blockers: SpeakerRosterRefreshBlockers): boolean {
  return !(
    blockers.paused ||
    blockers.hidden ||
    !blockers.focused ||
    !mayManuallyRefreshSpeakerRoster(blockers)
  );
}

/** A deliberate click may override only the session's automatic-pause control. */
export function mayManuallyRefreshSpeakerRoster(blockers: SpeakerRosterRefreshBlockers): boolean {
  return !(
    blockers.dialogOpen ||
    blockers.dirtyEditor ||
    blockers.editableFocused ||
    blockers.pending
  );
}

export function speakerRosterRefreshStatus(
  blockers: SpeakerRosterRefreshBlockers,
  lastRefreshRequestedAt: number | null,
): string {
  if (blockers.paused) return "Live refresh is paused for this browser tab.";
  if (blockers.hidden || !blockers.focused) return "Live refresh resumes when this tab is active.";
  if (blockers.dialogOpen || blockers.dirtyEditor || blockers.editableFocused) {
    return "Live refresh waits while you edit.";
  }
  if (blockers.pending) return "Refreshing speaker status…";
  if (lastRefreshRequestedAt === null) return "Live refresh checks every 20 seconds.";
  return `Refresh requested at ${new Date(lastRefreshRequestedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`;
}
