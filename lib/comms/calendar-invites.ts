import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { buildIcsCalendar, icsFilename, type IcsEvent } from "@/lib/calendar/ics";
import { dispatchEmail, type EmailAttachment, type Fetcher } from "@/lib/comms/send";
import {
  renderEmailTemplate,
  scheduledReminderSessions,
  type ReminderSession,
  type ScheduledReminderSession,
} from "@/lib/comms/reminders";
import { formatEventDateTime } from "@/lib/tz";

/**
 * Calendar invitations that land in a speaker's own calendar.
 *
 * The reminders route can already *attach* an `.ics`, but that file is
 * informational: it has no attendee, no revision number, and a UID shared with
 * the public export, so Gmail and Outlook file it as "a calendar file someone
 * sent me" rather than an invitation with accept/decline. Four things change
 * that, and all four are the reason this module exists rather than another
 * boolean on the reminder request:
 *
 * 1. `METHOD:REQUEST` on the VCALENDAR *and* on the MIME part.
 * 2. An `ORGANIZER`, so a reply has somewhere to go.
 * 3. An `ATTENDEE` that is this recipient, `PARTSTAT=NEEDS-ACTION;RSVP=TRUE`.
 * 4. A UID stable per (session, speaker) plus a `SEQUENCE` that rises when the
 *    slot moves — which is what makes a second send an *update* to the entry
 *    already in their calendar instead of a duplicate sitting beside it.
 *
 * Pure functions plus one send service that takes its database and its fetcher,
 * so every rule below is testable without Postgres or a network.
 */

/**
 * Its own template key, not a reuse of `session-scheduled`. `EmailDispatch`
 * hangs off `EmailTemplate` and the email history panel renders the template's
 * key and trigger, so sharing a row would make invitations indistinguishable
 * from reminders in the one place an operator goes to ask what was sent.
 */
export const CALENDAR_INVITE_TEMPLATE_KEY = "calendar-invite";

export const CALENDAR_INVITE_DEFAULT_TEMPLATE = {
  subject: "Calendar invite: your session at {{eventName}}",
  htmlBody:
    "<p>Hi {{speakerName}},</p><p>Here is the calendar invitation for <strong>{{talkTitle}}</strong> at {{eventName}}, {{slotTime}} in {{roomName}}.</p><p>Accept it to put the session in your own calendar — we will send an update to the same entry if anything moves.</p>",
  trigger: "calendar.invite",
} as const;

/**
 * The MIME type that decides whether this is an invitation or a download.
 *
 * `method=REQUEST` on the part itself is what Gmail and Outlook inspect; a
 * `text/calendar` part without it, or an `application/octet-stream` part with
 * the right bytes inside, both degrade to a plain attachment.
 */
export const CALENDAR_INVITE_CONTENT_TYPE = "text/calendar; charset=utf-8; method=REQUEST";

/**
 * Same bound as the reminder trigger's explicit recipient list. An operator
 * naming individual speakers is capped; "everyone scheduled" stays bounded by
 * the route's own event-wide query cap, exactly as reminders are.
 */
export const CALENDAR_INVITE_MAX_SELECTED_RECIPIENTS = 100;

const idSchema = z.string().trim().min(1).max(191);

/** Input contract for the admin-only calendar-invite trigger. */
export const calendarInviteRequestSchema = z.object({
  eventId: idSchema,
  // Omit to invite every speaker with a published, scheduled session.
  recipientUserIds: z.array(idSchema).min(1).max(CALENDAR_INVITE_MAX_SELECTED_RECIPIENTS).optional(),
}).superRefine((value, ctx) => {
  if (value.recipientUserIds && new Set(value.recipientUserIds).size !== value.recipientUserIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["recipientUserIds"], message: "Recipients must be unique." });
  }
});

export type CalendarInviteRequest = z.infer<typeof calendarInviteRequestSchema>;

/**
 * A speaker being invited. Deliberately the reminder session shape: a session
 * is "scheduled" here for exactly the reason it is there — a start, an end and
 * a room — so the two surfaces cannot disagree about who is schedulable.
 */
export type CalendarInviteSpeaker = {
  userId: string;
  name: string;
  email: string;
  sessions: ReminderSession[];
};

export type InviteOrganizer = { email: string; name?: string | null };

/** Speakers who have at least one published, scheduled session to invite them to. */
export function inviteReadySpeakers(speakers: CalendarInviteSpeaker[]): CalendarInviteSpeaker[] {
  return speakers.filter((speaker) => scheduledReminderSessions(speaker.sessions).length > 0);
}

/**
 * The UID that makes a re-send an update.
 *
 * Per (session, speaker) and derived from nothing else: a talk that is renamed,
 * moved, or re-roomed keeps the same UID, so the recipient's calendar client
 * matches the incoming REQUEST to the entry it already holds and revises it.
 * Per-speaker rather than per-session because each recipient is answering for
 * themselves — a shared UID would make two co-speakers' RSVPs collide.
 *
 * Namespaced away from the public export's `<sessionId>@greenroom`, which is a
 * different object with a different meaning to the same calendar client.
 */
export function calendarInviteUid(sessionId: string, speakerEmail: string): string {
  const digest = createHash("sha256")
    .update(`greenroom:calendar-invite:v1:${sessionId}:${speakerEmail.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
  return `${digest}@greenroom`;
}

/** SEQUENCE counts whole seconds from this instant; see `calendarInviteSequence`. */
const SEQUENCE_EPOCH_MS = Date.UTC(2020, 0, 1);

/**
 * A revision number derived from the schedule slot, not from a counter column.
 *
 * `ScheduleSlot.updatedAt` is Prisma `@updatedAt`, so any write that moves a
 * session's time or room raises it, and seconds-since-2020 turns that into a
 * monotonically increasing integer small enough for every client that treats
 * SEQUENCE as 32-bit (it passes 2^31 in 2088).
 *
 * The honest limitation: this tracks the *slot*. Renaming a session touches
 * `Session.updatedAt`, which this cannot see, so a title-only edit re-sends at
 * an unchanged SEQUENCE and a strict client may keep the old wording. Fixing
 * that properly means a revision column on the slot, which is a schema change
 * this feature deliberately does not make. Callers with no slot metadata get 0,
 * which RFC 5545 also treats as the absent default.
 */
export function calendarInviteSequence(slotUpdatedAt?: Date | null): number {
  if (!slotUpdatedAt || Number.isNaN(slotUpdatedAt.getTime())) return 0;
  const seconds = Math.floor((slotUpdatedAt.getTime() - SEQUENCE_EPOCH_MS) / 1000);
  return seconds > 0 ? seconds : 0;
}

/** `Display Name <someone@example.test>` or a bare address — the RESEND_FROM contract. */
const FROM_WITH_DISPLAY_NAME = /^(?:([^<>\r\n]+)\s)?<([^<>\s]+)>$/;

/**
 * Who the invitation is from.
 *
 * The deployment's configured sender is the only address a reply could actually
 * reach, so it wins. Without one — a demo or unconfigured deployment — the
 * organizer is synthesised from the app's own host purely so the file is
 * well-formed; those deployments are also the ones where `dispatchEmail` mocks
 * delivery, so no unreachable organizer is ever put in front of a speaker.
 */
export function resolveInviteOrganizer(from?: string, appUrl?: string): InviteOrganizer {
  const configured = from?.trim();
  if (configured) {
    const match = configured.match(FROM_WITH_DISPLAY_NAME);
    if (match) return { email: match[2], name: match[1]?.trim() || null };
    return { email: configured, name: null };
  }
  let host = "greenroom.invalid";
  if (appUrl) {
    try {
      host = new URL(appUrl).hostname || host;
    } catch {
      // A malformed APP_URL is not worth failing a send over; keep the placeholder.
    }
  }
  return { email: `no-reply@${host}`, name: null };
}

/**
 * One VCALENDAR per speaker carrying one VEVENT per scheduled session.
 *
 * Multiple VEVENTs under a single `METHOD:REQUEST` is valid (RFC 5546 §3.2.1)
 * and is what keeps a three-session speaker to one email; each VEVENT keeps its
 * own per-session UID so the client files three separate entries it can revise
 * independently.
 *
 * Returns null when this speaker has nothing scheduled — the caller must never
 * send an invitation with no event in it.
 */
export function buildCalendarInviteRequest(
  speaker: CalendarInviteSpeaker,
  options: { eventName: string; organizer: InviteOrganizer; appUrl?: string },
): (EmailAttachment & { contentType: string }) | null {
  const scheduled = scheduledReminderSessions(speaker.sessions);
  if (scheduled.length === 0) return null;

  const appUrl = options.appUrl?.replace(/\/$/, "");
  const events: IcsEvent[] = scheduled.map((session: ScheduledReminderSession) => ({
    uid: calendarInviteUid(session.id, speaker.email),
    title: session.title,
    description: session.description,
    startsAt: session.startsAt,
    endsAt: session.endsAt,
    location: session.roomName,
    url: appUrl ? `${appUrl}/embed/schedule` : null,
    organizerName: options.organizer.name,
    organizerEmail: options.organizer.email,
    attendees: [{ email: speaker.email, name: speaker.name }],
    status: "CONFIRMED",
    sequence: calendarInviteSequence(session.calendarUpdatedAt),
  }));

  // A wall-clock DTSTAMP would change the bytes on every retry and defeat the
  // provider idempotency key `dispatchEmail` derives from the message. The
  // newest slot revision is stable until the invitation data itself changes —
  // the same choice `buildSpeakerCalendarInvite` makes for reminders.
  const stamp = new Date(Math.max(
    ...scheduled.map((session) => session.calendarUpdatedAt?.getTime() ?? session.startsAt.getTime()),
  ));

  return {
    filename: icsFilename(`${options.eventName}-calendar-invite`),
    content: buildIcsCalendar(events, {
      method: "REQUEST",
      calendarName: options.eventName,
      now: stamp,
    }),
    contentType: CALENDAR_INVITE_CONTENT_TYPE,
  };
}

/**
 * Runtime values for the invitation template. The first scheduled session names
 * the message; speakers with more get every session in the attachment, and the
 * template says so rather than pretending they have one.
 */
export function calendarInviteVariables({
  speaker,
  eventName,
  timeZone,
}: {
  speaker: CalendarInviteSpeaker;
  eventName: string;
  timeZone: string;
}): Record<string, string> {
  const scheduled = scheduledReminderSessions(speaker.sessions);
  const first = scheduled[0] ?? null;
  return {
    speakerName: speaker.name,
    eventName,
    talkTitle: first?.title ?? "",
    slotTime: formatEventDateTime(first?.startsAt, timeZone) ?? "",
    roomName: first?.roomName ?? "",
    calendarInviteNote:
      scheduled.length > 1
        ? `A calendar invite for all ${scheduled.length} of your sessions is attached.`
        : "A calendar invite is attached.",
  };
}

export type CalendarInviteDb = Pick<PrismaClient, "emailDispatch">;

/**
 * Counts, never a claim. `mocked` is its own number rather than a flag folded
 * into `sent`, because a demo-mode run and a delivered run are different facts
 * and the console prints whichever actually happened.
 */
export type CalendarInviteSummary = {
  recipientCount: number;
  sessionCount: number;
  sent: number;
  mocked: number;
  failed: number;
};

export type CalendarInviteSendInput = {
  template: { id: string; subject: string; htmlBody: string };
  speakers: CalendarInviteSpeaker[];
  eventName: string;
  timeZone: string;
  organizer: InviteOrganizer;
  appUrl?: string;
  senderId?: string | null;
  fetcher?: Fetcher;
};

/**
 * Send one invitation per speaker through the single audited transport.
 *
 * A speaker with nothing scheduled is skipped rather than mailed an empty
 * calendar, so `recipientCount` is what was actually attempted. Every send is an
 * `EmailDispatch` row written before the provider call by `dispatchEmail`; the
 * `kind` variable records what these rows are without adding a column.
 */
export async function sendCalendarInvites(
  db: CalendarInviteDb,
  input: CalendarInviteSendInput,
): Promise<CalendarInviteSummary> {
  const summary: CalendarInviteSummary = { recipientCount: 0, sessionCount: 0, sent: 0, mocked: 0, failed: 0 };

  for (const speaker of input.speakers) {
    const invite = buildCalendarInviteRequest(speaker, {
      eventName: input.eventName,
      organizer: input.organizer,
      appUrl: input.appUrl,
    });
    if (!invite) continue;

    const sessions = scheduledReminderSessions(speaker.sessions);
    summary.recipientCount++;
    summary.sessionCount += sessions.length;

    const variables = calendarInviteVariables({
      speaker,
      eventName: input.eventName,
      timeZone: input.timeZone,
    });
    const rendered = renderEmailTemplate(input.template, variables);

    const outcome = await dispatchEmail(db, {
      templateId: input.template.id,
      senderId: input.senderId ?? null,
      message: {
        to: speaker.email,
        subject: rendered.subject,
        html: rendered.html,
        attachments: [invite],
      },
      variables: {
        ...variables,
        kind: "calendar-invite",
        sessionCount: String(sessions.length),
      },
      fetcher: input.fetcher,
    });

    if (outcome.status === "sent") summary.sent++;
    else if (outcome.status === "mocked") summary.mocked++;
    else summary.failed++;
  }

  return summary;
}
