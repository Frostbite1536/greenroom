/**
 * CSV rendering for the three whole-dataset exports added beside the ABS-13
 * review-results export (D-C5-16 #4): speakers, sessions, schedule.
 *
 * Pure and database-free, exactly like `decision-export-csv.ts`: the routes
 * supply rows that are already bounded, event-scoped and ordered, and every
 * value is one an admin surface already renders. Nothing is aggregated here.
 *
 * EXPOSURE RULES, which are the whole design of this file:
 *
 * - **Speaker email ships in the speakers export only.** `/admin/speakers`
 *   prints it under every name; a contact export without it is not a contact
 *   export, and this is the CRM-parity gap the lane exists to close. The
 *   sessions and schedule exports carry speaker *names* only, matching the
 *   decision export ("the organizer decision table drops speaker email on
 *   purpose, and an export is not the place to quietly widen a projection")
 *   and matching the public programme those two files describe.
 * - **No export carries an evaluator identity, a score, or a review comment.**
 *   None of these builders is even given one, and `NEVER_EXPORTED` below is
 *   asserted against every assembled document by the tests.
 * - **Narrower than the screen where the screen is prose.** The roster renders
 *   a bio and a headshot URL; neither is a column here. An export widens
 *   nothing, and it does not have to carry everything either.
 */
import { csvDocument, csvFilename } from "@/lib/services/csv";
import { formatTime, zonedParts } from "@/lib/tz";

/**
 * Substrings that must never appear in any header this module emits. Pinned by
 * test: the blind-review boundary is a property of the column contract, not of
 * one route's select.
 */
export const NEVER_EXPORTED = ["evaluator", "reviewer", "score", "rubric", "comment"] as const;

// ---- speakers --------------------------------------------------------------

/**
 * Column order is part of the contract: a saved spreadsheet template breaks if
 * columns move, so append rather than reorder. Each column maps 1:1 onto a
 * column of the `/admin/speakers` table.
 */
export const SPEAKER_EXPORT_HEADER = [
  "name",
  "email",
  "company",
  "job_title",
  "confirmation_status",
  "sessions_total",
  "sessions_scheduled",
  "session_titles",
  "profile_percent",
  "profile_missing",
  "tasks_complete",
  "tasks_total",
  "required_tasks_open",
  "next_required_due_at",
  "overdue_required_tasks",
  "onboarding_complete",
] as const;

/** Exactly the roster row, minus the prose the export deliberately drops. */
export type SpeakerExportRow = {
  name: string;
  email: string;
  company: string | null;
  jobTitle: string | null;
  status: string;
  sessionCount: number;
  scheduledCount: number;
  sessionTitles: readonly string[];
  profilePercent: number;
  profileMissing: readonly string[];
  tasksDone: number;
  tasksTotal: number;
  requiredOutstanding: readonly string[];
  nextRequiredDueAt: string | null;
  overdueRequired: number;
  onboardingComplete: boolean;
};

export type BoundedExport<T> = {
  rows: readonly T[];
  /** True when the underlying bounded read was cut (S20). */
  truncated: boolean;
};

/**
 * A truncated export says so in a final comment row, in the first column, so
 * the honesty survives being opened in a spreadsheet — a silently short export
 * is the failure mode that actually misleads an organizer. Like the ABS-13
 * notice it names the limit and recommends no step the route cannot honour.
 */
function truncationNotice(count: number, noun: string): string {
  // Semicolons, not commas: a comma would make the escaper quote the whole
  // notice, and a quoted comment row reads as data in a spreadsheet. The
  // ABS-13 notice is punctuated the same way for the same reason.
  return `# Truncated: this event holds more ${noun} than one bounded read loads; this export contains ${count} of them and is not the complete list.`;
}

export function buildSpeakerExportCsv(input: BoundedExport<SpeakerExportRow>): string {
  return csvDocument(
    SPEAKER_EXPORT_HEADER,
    input.rows.map((row) => [
      row.name,
      row.email,
      row.company,
      row.jobTitle,
      row.status,
      row.sessionCount,
      row.scheduledCount,
      row.sessionTitles.join("; "),
      row.profilePercent,
      row.profileMissing.join("; "),
      row.tasksDone,
      row.tasksTotal,
      row.requiredOutstanding.join("; "),
      row.nextRequiredDueAt,
      row.overdueRequired,
      // "yes"/"no" rather than true/false: a spreadsheet reads TRUE as a
      // boolean in one locale and as text in another.
      row.onboardingComplete ? "yes" : "no",
    ]),
    input.truncated ? truncationNotice(input.rows.length, "speakers") : null,
  );
}

export function speakerExportFilename(now: Date = new Date()): string {
  return csvFilename("speakers", now);
}

// ---- sessions --------------------------------------------------------------

export const SESSION_EXPORT_HEADER = [
  "session_id",
  "title",
  "content_status",
  "format",
  "duration_minutes",
  "category",
  "track",
  "room",
  "starts_at",
  "ends_at",
  "scheduled",
  "speakers",
] as const;

/** The agenda builder's own session projection, plus resolved room/track names. */
export type SessionExportRow = {
  id: string;
  title: string;
  contentStatus: string;
  format: string | null;
  durationMinutes: number;
  categoryName: string | null;
  trackName: string | null;
  roomName: string | null;
  startsAt: string | null;
  endsAt: string | null;
  speakerNames: readonly string[];
};

export function buildSessionExportCsv(input: BoundedExport<SessionExportRow>): string {
  return csvDocument(
    SESSION_EXPORT_HEADER,
    input.rows.map((row) => [
      row.id,
      row.title,
      row.contentStatus,
      row.format,
      row.durationMinutes,
      row.categoryName,
      row.trackName,
      row.roomName,
      row.startsAt,
      row.endsAt,
      // The agenda's own rule: "scheduled" means the talk holds a slot.
      row.startsAt === null ? "no" : "yes",
      row.speakerNames.join("; "),
    ]),
    input.truncated ? truncationNotice(input.rows.length, "talks") : null,
  );
}

export function sessionExportFilename(now: Date = new Date()): string {
  return csvFilename("sessions", now);
}

// ---- schedule --------------------------------------------------------------

export const SCHEDULE_EXPORT_HEADER = [
  "day",
  "starts_at_local",
  "ends_at_local",
  "room",
  "track",
  "session_title",
  "speakers",
  "duration_minutes",
  "starts_at_utc",
  "ends_at_utc",
] as const;

/** One placed slot. Unplaced talks are not schedule rows and are absent. */
export type ScheduleExportRow = {
  startsAt: string;
  endsAt: string;
  roomName: string;
  trackName: string | null;
  sessionTitle: string;
  speakerNames: readonly string[];
};

export type ScheduleExportInput = BoundedExport<ScheduleExportRow> & {
  /** The event's stored IANA zone: a schedule read in the browser's zone is a
   *  different schedule, so the local columns are pinned to the event's. */
  timezone: string;
};

export function buildScheduleExportCsv(input: ScheduleExportInput): string {
  return csvDocument(
    SCHEDULE_EXPORT_HEADER,
    input.rows.map((row) => {
      const minutes = Math.round(
        (new Date(row.endsAt).getTime() - new Date(row.startsAt).getTime()) / 60_000,
      );
      return [
        // The agenda's own event-local calendar key, from `zonedParts`.
        zonedParts(row.startsAt, input.timezone).dateKey,
        formatTime(row.startsAt, input.timezone),
        formatTime(row.endsAt, input.timezone),
        row.roomName,
        row.trackName,
        row.sessionTitle,
        row.speakerNames.join("; "),
        Number.isFinite(minutes) ? minutes : null,
        // The stored instants ride along so a downstream import never has to
        // re-derive a zone from a rendered clock time.
        row.startsAt,
        row.endsAt,
      ];
    }),
    input.truncated ? truncationNotice(input.rows.length, "placed talks") : null,
  );
}

export function scheduleExportFilename(now: Date = new Date()): string {
  return csvFilename("schedule", now);
}
