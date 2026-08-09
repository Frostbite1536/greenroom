import { ApiError } from "@/lib/api/http";

/**
 * Operator-facing reads deliberately cap the event data they materialize in one
 * request. Routes fetch one additional row and reject oversize events instead
 * of silently exporting, dispatching, or importing a partial result.
 */
export const OPERATOR_QUERY_LIMITS = {
  mirrorSessions: 2_000,
  acceleventsSessions: 2_000,
  decidedAbstracts: 2_000,
  sessionSpeakersPerSession: 100,
  reminderSessionSpeakers: 2_000,
  openTasksPerReminderSpeaker: 500,
  templates: 500,
  importForms: 250,
  importCategories: 1_000,
  importFieldsPerForm: 250,
  settingsRooms: 500,
  settingsTracks: 250,
  settingsCategories: 1_000,
  adminReviewComments: 5_000,
} as const;

export function assertEventQueryBound(
  rows: { length: number },
  limit: number,
  resource: string,
): void {
  if (rows.length > limit) {
    throw new ApiError(
      422,
      "EVENT_QUERY_LIMIT_EXCEEDED",
      `This event has more than ${limit} ${resource}. Reduce the event data before retrying this operation.`,
    );
  }
}
