/**
 * Canonical public calendar-export URLs for the schedule embed.
 *
 * Calendar content is generated server-side by `/api/comms/calendar`, which
 * keeps RFC 5545 formatting and download headers in one place.
 */
import { serializeItinerarySessionIds } from "./itinerary";

export function calendarExportUrl(eventId: string, sessionId?: string): string {
  const query = new URLSearchParams({ eventId });
  if (sessionId) query.set("sessionId", sessionId);
  return `/api/comms/calendar?${query}`;
}

/**
 * The same route, given the reader's starred session ids.
 *
 * A plain link, so "Download my itinerary (.ics)" needs no fetch and no
 * client-side file construction. The id list is reader-supplied and therefore
 * only a *narrowing* hint: the route re-applies the event-scoped
 * published-and-placed predicate, so an unknown or held-back id contributes
 * nothing. Returns null for an empty selection — there is no such thing as an
 * empty calendar download.
 */
export function itineraryExportUrl(eventId: string, sessionIds: readonly string[]): string | null {
  const sessions = serializeItinerarySessionIds(sessionIds);
  if (!sessions) return null;
  const query = new URLSearchParams({ eventId, sessions });
  return `/api/comms/calendar?${query}`;
}
