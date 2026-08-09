import { ApiError } from "@/lib/api/http";

type EventOwnedRow = { eventId: string };

/**
 * Authorize a row that was read under its write lock. Unknown ids and ids from
 * another event intentionally share the same response, so a caller cannot use
 * this check to enumerate another event's records.
 */
export function requireEventOwnedRow<T extends EventOwnedRow>(
  row: T | null | undefined,
  eventId: string,
  code: string,
  resourceName: string,
): T {
  if (!row || row.eventId !== eventId) {
    throw new ApiError(404, code, `${resourceName} not found.`);
  }
  return row;
}
