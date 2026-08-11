import { formatTimeRange } from "@/lib/tz";

/**
 * A refused placement, said out loud.
 *
 * `detectConflicts` returns identifiers — a type, the conflicting slot's id and
 * a generic message ("Room is already booked for an overlapping time."). That
 * is enough to refuse the write and nothing like enough to act on: the
 * organizer is looking at a schedule of a dozen rooms and is not told WHICH
 * booking they collided with, in which room, at what time, or with whom.
 *
 * This module turns a conflict plus the conflicting slot's own names into the
 * sentence the agenda builder prints. It is pure so the wording is unit
 * testable and cannot drift between the two surfaces that render it (the
 * schedule dialog and the drag-and-drop move banner).
 *
 * Times are formatted through `lib/tz`'s `formatTimeRange`, i.e. in the
 * EVENT's timezone with its abbreviation, never the reader's browser clock —
 * an organizer in another city must not be told a different hour than the one
 * the slot actually occupies.
 */

/** Long talk titles are trimmed so one conflict stays one readable line. */
const TITLE_MAX = 58;

export function conflictTitle(title: string, max = TITLE_MAX): string {
  const clean = title.trim();
  if (clean.length === 0) return "an untitled session";
  // Trim on the trailing space so the ellipsis never lands mid-word.
  if (clean.length <= max) return `“${clean}”`;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `“${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…”`;
}

export type ConflictNaming = {
  type: "ROOM_OVERLAP" | "SPEAKER_OVERLAP";
  /** The room the CONFLICTING slot occupies. */
  roomName: string;
  /** The conflicting session's own title. */
  sessionTitle: string;
  /** The conflicting slot's bounds, as ISO instants. */
  startsAt: string;
  endsAt: string | null;
  /** The double-booked speaker's name, for `SPEAKER_OVERLAP`. */
  speakerName: string | null;
  /** The event's IANA timezone — the only clock a refusal may quote. */
  timeZone: string;
};

export function describeScheduleConflict(conflict: ConflictNaming): string {
  const when = formatTimeRange(conflict.startsAt, conflict.endsAt, conflict.timeZone);
  const title = conflictTitle(conflict.sessionTitle);
  const room = conflict.roomName.trim() || "That room";

  if (conflict.type === "ROOM_OVERLAP") {
    return `Room conflict: ${room} is occupied by ${title} from ${when}.`;
  }

  // A resolvable id with no readable name is still more useful than silence,
  // so fall back rather than dropping the whole sentence.
  const who = conflict.speakerName?.trim() || "A speaker on this talk";
  return `Speaker conflict: ${who} is already speaking in ${title} in ${room} from ${when}.`;
}

/**
 * The refusal's own sentences, in detection order. Kept separate from
 * `describeScheduleConflict` so the route can map over whatever it managed to
 * resolve and drop nothing silently.
 */
export function describeScheduleConflicts(
  conflicts: ReadonlyArray<ConflictNaming>,
): string[] {
  return conflicts.map(describeScheduleConflict);
}
