import { z } from "zod";
import { buildIcsCalendar, icsFilename, type IcsEvent } from "@/lib/calendar/ics";
import { sanitizeHtml } from "@/lib/sanitize-html";

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
};

export type EligibleSpeaker = {
  userId: string;
  name: string;
  email: string;
  openTasks: number;
  sessions: ReminderSession[];
};

export type RenderedEmail = { subject: string; html: string };

/**
 * Select event speakers without silently accepting ids from another event.
 * Routes turn `invalidUserIds` into a stable 422 response before dispatching.
 */
export function selectEligibleSpeakers(
  eligible: EligibleSpeaker[],
  requestedUserIds?: string[],
): { recipients: EligibleSpeaker[]; invalidUserIds: string[] } {
  if (!requestedUserIds) return { recipients: eligible, invalidUserIds: [] };

  const byId = new Map(eligible.map((speaker) => [speaker.userId, speaker]));
  const recipients: EligibleSpeaker[] = [];
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
    subject: renderText(template.subject, variables),
    html: safeHtml.replace(/{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}/g, (_match, key: string) => escapeHtml(variables[key] ?? "")),
  };
}

/** Build a per-speaker invitation attachment from their scheduled sessions only. */
export function buildSpeakerCalendarInvite(
  speaker: EligibleSpeaker,
  eventName: string,
  appUrl?: string,
): { filename: string; content: string } | null {
  const events: IcsEvent[] = speaker.sessions
    .filter((session): session is ReminderSession & { startsAt: Date; endsAt: Date; roomName: string } =>
      Boolean(session.startsAt && session.endsAt && session.roomName),
    )
    .map((session) => ({
      uid: `${session.id}@greenroom`,
      title: session.title,
      description: session.description,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      location: session.roomName,
      url: appUrl ? `${appUrl.replace(/\/$/, "")}/embed/schedule` : null,
    }));

  if (events.length === 0) return null;
  return {
    filename: icsFilename(`${eventName}-invite`),
    content: buildIcsCalendar(events, { method: "REQUEST", calendarName: eventName }),
  };
}
