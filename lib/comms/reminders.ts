import { z } from "zod";
import { buildIcsCalendar, icsFilename, type IcsEvent } from "@/lib/calendar/ics";
import { sanitizeHtml } from "@/lib/sanitize-html";
import { normalizeEmailSubject } from "@/lib/comms/subject";
import { formatEventDateTime } from "@/lib/tz";

const idSchema = z.string().trim().min(1).max(191);

/** Input contract for the admin-only reminder trigger. Kept local while the template UI is pending. */
export const reminderRequestSchema = z.object({
  eventId: idSchema,
  templateKey: z.string().trim().min(1).max(120),
  // Omit to send to every eligible speaker in the active event.
  recipientUserIds: z.array(idSchema).min(1).max(100).optional(),
  variables: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/), z.string().max(2_000)).default({}),
  includeCalendarInvite: z.boolean().default(false),
}).superRefine((value, ctx) => {
  if (value.recipientUserIds && new Set(value.recipientUserIds).size !== value.recipientUserIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["recipientUserIds"], message: "Recipients must be unique." });
  }
});

export type ReminderRequest = z.infer<typeof reminderRequestSchema>;

export type ReminderSession = {
  id: string;
  title: string;
  description: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  roomName: string | null;
  /** Stable source for invitation DTSTAMP and retry idempotency. */
  calendarUpdatedAt?: Date | null;
};

export type EligibleSpeaker = {
  userId: string;
  name: string;
  email: string;
  openTasks: number;
  /** Due dates for the currently open tasks, kept event-scoped by the route. */
  openTaskDueDates: Date[];
  sessions: ReminderSession[];
};

export type RenderedEmail = { subject: string; html: string };

/** Stable order for message variables and byte-identical calendar retries. */
export function orderReminderSessions(sessions: ReminderSession[]): ReminderSession[] {
  return [...sessions].sort((left, right) => {
    const leftStart = left.startsAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const rightStart = right.startsAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (leftStart !== rightStart) return leftStart - rightStart;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

export type ScheduledReminderSession = ReminderSession & {
  startsAt: Date;
  endsAt: Date;
  roomName: string;
};

/**
 * One bounded definition of a scheduled speaker session. It deliberately
 * matches the calendar attachment contract: a time window and a room are both
 * required before email may describe a session as scheduled.
 */
export function scheduledReminderSessions(sessions: ReminderSession[]): ScheduledReminderSession[] {
  return orderReminderSessions(sessions).filter((session): session is ScheduledReminderSession =>
    Boolean(session.startsAt && session.endsAt && session.roomName),
  );
}

export function hasScheduledReminderSession(speaker: EligibleSpeaker): boolean {
  return scheduledReminderSessions(speaker.sessions).length > 0;
}

function earliestOpenTaskDeadline(speaker: EligibleSpeaker): Date | null {
  const deadlines = speaker.openTaskDueDates.filter((date) => !Number.isNaN(date.getTime()));
  if (deadlines.length === 0) return null;
  return deadlines.reduce((earliest, date) => date.getTime() < earliest.getTime() ? date : earliest);
}

/**
 * Runtime fields for a reminder. Schedule-specific values intentionally remain
 * empty until this speaker has a real scheduled session; callers must use the
 * same calendar attachment result for the attachment note.
 */
export function reminderVariables({
  recipient,
  eventName,
  timeZone,
  calendarInviteAttached,
  variables = {},
}: {
  recipient: EligibleSpeaker;
  eventName: string;
  timeZone: string;
  calendarInviteAttached: boolean;
  variables?: Record<string, string>;
}): Record<string, string> {
  const scheduled = scheduledReminderSessions(recipient.sessions)[0] ?? null;
  const dueDate = earliestOpenTaskDeadline(recipient);

  return {
    ...variables,
    speakerName: recipient.name,
    eventName,
    openTasks: String(recipient.openTasks),
    dueDate: formatEventDateTime(dueDate, timeZone) ?? "",
    talkTitle: scheduled?.title ?? "",
    slotTime: formatEventDateTime(scheduled?.startsAt, timeZone) ?? "",
    roomName: scheduled?.roomName ?? "",
    calendarInviteNote: calendarInviteAttached && scheduled ? "A calendar invite is attached." : "",
  };
}

/**
 * Select event speakers without silently accepting ids from another event.
 * Routes turn `invalidUserIds` into a stable 422 response before dispatching.
 *
 * Generic over the speaker shape so the calendar-invite trigger reuses this
 * rule rather than reimplementing it: "an id the caller named is not in the
 * eligible set" must refuse identically on every send surface.
 */
export function selectEligibleSpeakers<T extends { userId: string }>(
  eligible: T[],
  requestedUserIds?: string[],
): { recipients: T[]; invalidUserIds: string[] } {
  if (!requestedUserIds) return { recipients: eligible, invalidUserIds: [] };

  const byId = new Map(eligible.map((speaker) => [speaker.userId, speaker]));
  const recipients: T[] = [];
  const invalidUserIds: string[] = [];
  for (const userId of requestedUserIds) {
    const speaker = byId.get(userId);
    if (speaker) recipients.push(speaker);
    else invalidUserIds.push(userId);
  }
  return { recipients, invalidUserIds };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderText(source: string, variables: Record<string, string>): string {
  return source
    .replace(/{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}/g, (_match, key: string) => variables[key] ?? "")
    // Subjects become email headers at the provider boundary; never preserve line breaks.
    .replace(/[\r\n]+/g, " ");
}

/** Render admin-authored template HTML with escaped runtime values. */
export function renderEmailTemplate(
  template: { subject: string; htmlBody: string },
  variables: Record<string, string>,
): RenderedEmail {
  const safeHtml = sanitizeHtml(template.htmlBody);
  return {
    subject: normalizeEmailSubject(renderText(template.subject, variables)),
    html: safeHtml.replace(/{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}/g, (_match, key: string) => escapeHtml(variables[key] ?? "")),
  };
}

/** Build a per-speaker invitation attachment from their scheduled sessions only. */
export function buildSpeakerCalendarInvite(
  speaker: EligibleSpeaker,
  eventName: string,
  appUrl?: string,
): { filename: string; content: string } | null {
  const scheduled = scheduledReminderSessions(speaker.sessions);
  const events: IcsEvent[] = scheduled.map((session) => ({
      uid: `${session.id}@greenroom`,
      title: session.title,
      description: session.description,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      location: session.roomName,
      url: appUrl ? `${appUrl.replace(/\/$/, "")}/embed/schedule` : null,
    }));

  if (events.length === 0) return null;
  // A fresh wall-clock DTSTAMP would change the attachment bytes on every
  // retry and defeat the provider's logical-send idempotency key. Schedule-slot
  // updatedAt is stable until the invitation data changes; startsAt is a
  // deterministic fallback for callers that do not carry persistence metadata.
  const stamp = new Date(Math.max(
    ...scheduled.map((session) => session.calendarUpdatedAt?.getTime() ?? session.startsAt.getTime()),
  ));
  return {
    filename: icsFilename(`${eventName}-invite`),
    content: buildIcsCalendar(events, { method: "REQUEST", calendarName: eventName, now: stamp }),
  };
}
