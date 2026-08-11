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
  // The agenda builder lays out every session at once, so this is a render
  // bound as much as a query one. Cap-plus-one with an honest notice rather
  // than a 422: refusing to open the grid would be worse for an operator than
  // opening it and saying which part is missing.
  agendaSessions: 2_000,
  // Onboarding-task templates are authored by hand, one checklist per event.
  onboardingTasks: 250,
  // Resource/wiki pages are hand-authored too — a handbook, a venue guide, a
  // few logistics pages per event.
  adminResources: 250,
  // Review rounds are authored by hand too — a handful per event. The
  // dashboard reads cap-plus-one and states truncation on the card; withdrawn
  // exclusion happens inside the assignment groupBy itself, so no id-set cap
  // exists to corrupt the totals.
  dashboardPlans: 100,
  settingsTracks: 250,
  settingsCategories: 1_000,
  adminAbstracts: 100,
  // The newest-page cap plus one separately scoped, valid older deep-link
  // selection. It does not enlarge the list API's 100-row parent page.
  adminDecisionAbstracts: 101,
  // Decision summaries cover the capped parent page plus at most one valid
  // selected older row. Dependent event reads are cap-plus-one and fail closed
  // rather than silently reporting a partial organizer decision number.
  adminDecisionPlans: 100,
  adminDecisionRubricCriteria: 250,
  adminDecisionAssignments: 5_000,
  adminDecisionScores: 25_000,
  adminReviewComments: 5_000,
  reviewerSetupMembers: 500,
  // The email log only grows, so its panel is a newest-first page rather than a
  // fail-closed read: exceeding the cap is normal and is reported honestly
  // instead of refusing the whole page.
  adminEmailDispatches: 100,
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
