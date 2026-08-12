/**
 * Which slide deck belongs to this speaker at this event, and where it came
 * from. Pure, so every surface that shows a deck resolves it identically.
 *
 * The roadmap's own words for the limitation this closes: "The global
 * `SpeakerProfile.slideDeckUrl` also needs a later per-event deck pointer or
 * association … one global profile URL cannot provide per-event-private deck
 * access." `SpeakerProfile` is one row per PERSON for the whole instance, so it
 * cannot hold a different deck for two events and cannot be private to one
 * event's organizers.
 *
 * `EventSpeakerDeck` holds the per-event value. The global column is kept and
 * kept working: an event with no association resolves to it exactly as before,
 * which is why adopting this feature changes nothing for an event that never
 * uses it.
 *
 * The SOURCE travels with the value on purpose. An organizer looking at a deck
 * link needs to know whether it is this event's deck or a link the speaker set
 * for a different conference, because those are different levels of confidence
 * and the second one is the reason this feature exists.
 */

export type SpeakerDeckSource = "event" | "profile";

export type ResolvedSpeakerDeck = {
  /** The deck to use, or null when the speaker has neither. */
  url: string | null;
  /** Where `url` came from. Null exactly when `url` is null. */
  source: SpeakerDeckSource | null;
};

function usable(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed === "" ? null : trimmed;
}

/**
 * Event deck first, global profile deck second.
 *
 * A blank or whitespace-only association is treated as absent rather than as an
 * empty deck: the write path deletes the row instead of storing `""`, so a
 * blank here would be data that should not exist, and falling back is the
 * honest reading of it either way.
 */
export function resolveSpeakerDeck(input: {
  eventDeckUrl?: string | null;
  profileDeckUrl?: string | null;
}): ResolvedSpeakerDeck {
  const eventDeck = usable(input.eventDeckUrl);
  if (eventDeck) return { url: eventDeck, source: "event" };
  const profileDeck = usable(input.profileDeckUrl);
  if (profileDeck) return { url: profileDeck, source: "profile" };
  return { url: null, source: null };
}

/**
 * How a deck's provenance is written on an organizer screen. Named rather than
 * inlined so the roster, the drawer, and any later surface cannot describe the
 * same fallback in three different ways.
 */
export const SPEAKER_DECK_SOURCE_LABELS: Record<SpeakerDeckSource, string> = {
  event: "This event",
  profile: "Global profile (fallback)",
};

export function speakerDeckSourceLabel(source: SpeakerDeckSource | null): string {
  return source === null ? "No deck" : SPEAKER_DECK_SOURCE_LABELS[source];
}

/**
 * The one-line explanation an organizer gets beside a fallback deck. Explicit
 * about what they are looking at, because a deck the speaker uploaded for
 * another conference is not the same artefact as one they uploaded for this
 * one — and silently rendering them the same way is the bug this feature fixes.
 */
export function speakerDeckSourceHint(source: SpeakerDeckSource | null): string | null {
  if (source === "profile") {
    return "This speaker has not set a deck for this event, so their global profile deck is shown.";
  }
  return null;
}

/**
 * Index a bounded read of `EventSpeakerDeck` rows by user for a fold over a
 * roster. Kept here rather than in the read so it is testable without a table.
 */
export function indexEventDecks(
  rows: readonly { userId: string; deckUrl: string }[],
): Map<string, string> {
  return new Map(rows.map((row) => [row.userId, row.deckUrl]));
}

/**
 * Resolve a whole roster at once: one entry per user id asked for, so a caller
 * folding over rendered rows never has to decide what a missing key means.
 */
export function resolveRosterDecks(
  userIds: readonly string[],
  eventDecks: ReadonlyMap<string, string>,
  profileDecks: ReadonlyMap<string, string | null>,
): Record<string, ResolvedSpeakerDeck> {
  const resolved: Record<string, ResolvedSpeakerDeck> = {};
  for (const userId of userIds) {
    resolved[userId] = resolveSpeakerDeck({
      eventDeckUrl: eventDecks.get(userId) ?? null,
      profileDeckUrl: profileDecks.get(userId) ?? null,
    });
  }
  return resolved;
}
