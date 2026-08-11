/**
 * Pure grouping for the agenda builder's Tracks view.
 *
 * Kept out of the client component for the same reason `agenda-layout` is: the
 * question this answers — which talk belongs under which heading, and in what
 * order — is arithmetic on strings, and is worth asserting without a DOM.
 *
 * Nothing here is authoritative. The server owns placement (`POST
 * /api/agenda/slots`, INV-SCHEDULE-001); this only decides how the placements
 * already read are stacked on the page.
 *
 * The shapes below are structural subsets of `AgendaSession` and `AgendaData`
 * from lib/data/reads. They are declared locally on purpose, the same way
 * `embed-schedule-view` declares its own: importing the reads module would drag
 * Prisma into a unit test that needs neither a database nor a client.
 */

export type TrackViewTrack = { id: string; name: string; color: string };

/** A session that is on the schedule. Unplaced talks never reach this view. */
export type TrackViewSession = {
  title: string;
  slot: { trackId: string | null; startsAt: string };
};

export type TrackGroup<S> = {
  /** The track's id, or null for the bucket of talks placed without one. */
  trackId: string | null;
  name: string;
  color: string;
  sessions: S[];
};

/**
 * Heading and rail colour for the untracked bucket. The colour is the same
 * fallback the builder's `trackColor()` returns for a null track, so a talk's
 * dot and its group heading cannot disagree about what "no track" looks like.
 */
export const NO_TRACK_NAME = "No track";
export const NO_TRACK_COLOR = "#687276";

/**
 * Fold placed sessions into one group per track, then the untracked bucket.
 *
 * Three rules, each of them a thing the view would otherwise get wrong:
 *
 * 1. Every configured track gets a group even when nothing is placed in it.
 *    A track an organizer created and never used is exactly what this view
 *    exists to make visible, so it is rendered and reported empty rather than
 *    dropped — the day grid's track columns already behave this way.
 * 2. A talk with no track lands in a trailing "No track" bucket instead of
 *    vanishing. The day grid matches slots to columns by track id, so an
 *    untracked talk is silently absent there; a view that claims to show the
 *    programme by track has to account for the talks that have none.
 * 3. A talk whose track id names no configured track lands in the same bucket.
 *    That happens when the track was deleted out from under the slot, and the
 *    alternative — a group headed by a raw id, or the talk disappearing — is
 *    worse than reporting it as untracked.
 *
 * The bucket is omitted when it is empty: a heading that reports nothing is a
 * heading that should not be rendered.
 *
 * Track order is the caller's order, which is the read's `sortOrder`. Within a
 * group, start time then title — the same tie-break `groupByDay` uses on the
 * public schedule, so two talks starting together are stably ordered.
 */
export function groupByTrack<S extends TrackViewSession>(
  sessions: readonly S[],
  tracks: readonly TrackViewTrack[],
): TrackGroup<S>[] {
  const groups = new Map<string, TrackGroup<S>>();
  for (const track of tracks) {
    groups.set(track.id, { trackId: track.id, name: track.name, color: track.color, sessions: [] });
  }

  const untracked: TrackGroup<S> = {
    trackId: null,
    name: NO_TRACK_NAME,
    color: NO_TRACK_COLOR,
    sessions: [],
  };

  for (const session of sessions) {
    const trackId = session.slot.trackId;
    const group = (trackId === null ? undefined : groups.get(trackId)) ?? untracked;
    group.sessions.push(session);
  }

  const ordered = [...groups.values()];
  if (untracked.sessions.length > 0) ordered.push(untracked);

  for (const group of ordered) {
    group.sessions.sort(
      (a, b) => a.slot.startsAt.localeCompare(b.slot.startsAt) || a.title.localeCompare(b.title),
    );
  }
  return ordered;
}

/**
 * What the view should say instead of a list, or null when it has one to show.
 *
 * Separated from the grouping so the empty cases are asserted as copy rather
 * than read out of a rendered tree. "No tracks and nothing placed" and "tracks
 * exist but nothing is placed" are different situations with different next
 * actions, and telling an organizer to add tracks they already have is the kind
 * of wrong-but-plausible advice an empty state gets away with unnoticed.
 */
export function trackViewEmptyCopy(
  groups: readonly TrackGroup<unknown>[],
): { title: string; detail: string } | null {
  const placed = groups.reduce((total, group) => total + group.sessions.length, 0);
  if (placed > 0) return null;

  if (groups.length === 0) {
    return {
      title: "No tracks yet",
      detail: "Add tracks in event settings, then place sessions on the schedule to see them grouped here.",
    };
  }
  return {
    title: "Nothing scheduled yet",
    detail: "Place a session from the backlog to see it appear under its track.",
  };
}
