/**
 * "My itinerary": the anonymous, client-persisted set of sessions a public
 * reader starred on the schedule.
 *
 * There are no attendee accounts, so the selection cannot be a row in the
 * database — it lives in the reader's own `localStorage`, namespaced per event
 * so two programmes on the same origin never share a starred set. Everything
 * that decides *what* the itinerary means lives here as plain functions, the
 * same split `lib/embed-schedule-view.ts` already uses: the client island stays
 * a thin renderer and this stays testable without a DOM.
 *
 * The id list is reader-controlled, so it is *never* trusted as an
 * authorization or visibility input. `parseItinerarySessionIds` only bounds and
 * normalizes it; the `.ics` route re-applies the same event-scoped
 * `PUBLISHED` + placed predicate every other public view of the programme uses,
 * so an id typed into the URL can at most name a session already on the public
 * schedule.
 */

export const ITINERARY_STORAGE_VERSION = 1;

const STORAGE_PREFIX = "greenroom.itinerary.v1";

/**
 * Ceiling on starred sessions, applied on both sides.
 *
 * Client-side it stops a stuck loop from growing an unbounded storage value;
 * server-side it bounds the `.ics` id list before it reaches a query, the same
 * reason `PUBLIC_AGENDA_LIMITS` exists. Well below the 500-session agenda cap
 * because a human itinerary is tens of sessions, not hundreds.
 */
export const MAX_ITINERARY_SESSIONS = 100;

/** Widest plausible shape of a session id (CUIDs are ~25 chars). */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type ItineraryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Versioned and event-scoped: a reader who visits two programmes on one origin
 * must not have the first event's stars appear on the second. The key takes the
 * event slug or id exactly as the page resolved it.
 */
export function itineraryStorageKey(eventKey: string): string {
  return `${STORAGE_PREFIX}:${eventKey}`;
}

/** Normalize, dedupe and bound an id list, dropping anything malformed. */
function normalizeIds(values: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (!ID_PATTERN.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_ITINERARY_SESSIONS) break;
  }
  return out;
}

/**
 * Parse a `?sessions=` value into bounded, deduped ids.
 *
 * Used by the `.ics` route. This is normalization only — it says nothing about
 * whether an id names a real, published, scheduled session of that event; the
 * route's own query decides that, and must, because this input is anonymous.
 */
export function parseItinerarySessionIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return normalizeIds(raw.split(","));
}

/** The `?sessions=` value for a set of ids, in the reader's own order. */
export function serializeItinerarySessionIds(ids: readonly string[]): string {
  return normalizeIds(ids).join(",");
}

/**
 * Browser storage can throw (disabled, quota, privacy mode) and its contents
 * are reader-editable, so a read is best-effort and always re-validated. A
 * failed read yields an empty itinerary rather than blocking the schedule.
 */
export function readItinerary(
  storage: ItineraryStorage | null | undefined,
  eventKey: string,
): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(itineraryStorageKey(eventKey));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const record = parsed as Record<string, unknown>;
    if (record.version !== ITINERARY_STORAGE_VERSION) return [];
    return Array.isArray(record.sessionIds) ? normalizeIds(record.sessionIds) : [];
  } catch (error) {
    // Never log the key or the ids: which sessions a reader picked is their
    // business. A bounded operation label and the original error only.
    console.error("Itinerary storage read failed", error);
    return [];
  }
}

export function writeItinerary(
  storage: ItineraryStorage | null | undefined,
  eventKey: string,
  sessionIds: readonly string[],
): boolean {
  if (!storage) return false;
  try {
    const ids = normalizeIds(sessionIds);
    if (ids.length === 0) {
      storage.removeItem(itineraryStorageKey(eventKey));
      return true;
    }
    storage.setItem(itineraryStorageKey(eventKey), JSON.stringify({
      version: ITINERARY_STORAGE_VERSION,
      sessionIds: ids,
    }));
    return true;
  } catch (error) {
    console.error("Itinerary storage write failed", error);
    return false;
  }
}

/** Add or remove one id, refusing to grow past the cap. */
export function toggleItineraryId(current: readonly string[], sessionId: string): string[] {
  const ids = normalizeIds(current);
  if (!ID_PATTERN.test(sessionId.trim())) return ids;
  const id = sessionId.trim();
  if (ids.includes(id)) return ids.filter((value) => value !== id);
  if (ids.length >= MAX_ITINERARY_SESSIONS) return ids;
  return [...ids, id];
}

export type ItinerarySession = {
  sessionId: string;
  title: string;
  /** ISO instants, as the public agenda read already serializes them. */
  startsAt: string;
  endsAt: string;
  roomName: string;
  trackName: string | null;
  trackColor: string | null;
};

/** Starred sessions in start-time order, ties broken by title for stability. */
export function itinerarySessions(
  sessions: readonly ItinerarySession[],
  selectedIds: readonly string[],
): ItinerarySession[] {
  const selected = new Set(normalizeIds(selectedIds));
  return sessions
    .filter((session) => selected.has(session.sessionId))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.title.localeCompare(b.title));
}

/**
 * Which chosen sessions collide, and with what.
 *
 * Half-open intervals: a talk ending at 10:00 does not overlap one starting at
 * 10:00, which is the same rule the agenda builder's conflict display and the
 * server's schedule service use — a back-to-back pair is a walk, not a clash.
 * Keyed by session id, and every colliding pair is reported from both sides so
 * either row can name the other.
 */
export function itineraryOverlaps(
  sessions: readonly Pick<ItinerarySession, "sessionId" | "title" | "startsAt" | "endsAt">[],
): Map<string, string[]> {
  const overlaps = new Map<string, string[]>();
  const add = (id: string, title: string) => {
    const existing = overlaps.get(id);
    if (existing) existing.push(title);
    else overlaps.set(id, [title]);
  };

  for (let i = 0; i < sessions.length; i += 1) {
    for (let j = i + 1; j < sessions.length; j += 1) {
      const a = sessions[i];
      const b = sessions[j];
      const collides = a.startsAt < b.endsAt && b.startsAt < a.endsAt;
      if (!collides) continue;
      add(a.sessionId, b.title);
      add(b.sessionId, a.title);
    }
  }
  return overlaps;
}

/** "overlaps with X" / "overlaps with X and Y", or null when it is clear. */
export function overlapNotice(titles: readonly string[] | undefined): string | null {
  if (!titles || titles.length === 0) return null;
  if (titles.length === 1) return `Overlaps with ${titles[0]}`;
  const head = titles.slice(0, -1).join(", ");
  return `Overlaps with ${head} and ${titles[titles.length - 1]}`;
}

/** "My itinerary (3)" — the count is part of the label, not a separate node. */
export function itineraryTabLabel(count: number): string {
  return count > 0 ? `My itinerary (${count})` : "My itinerary";
}
