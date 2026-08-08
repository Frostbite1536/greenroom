/**
 * Canonical public calendar-export URLs for the schedule embed.
 *
 * Calendar content is generated server-side by `/api/comms/calendar`, which
 * keeps RFC 5545 formatting and download headers in one place.
 */
export function calendarExportUrl(eventId: string, sessionId?: string): string {
  const query = new URLSearchParams({ eventId });
  if (sessionId) query.set("sessionId", sessionId);
  return `/api/comms/calendar?${query}`;
}
