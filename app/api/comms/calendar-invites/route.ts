import { prisma } from "@/lib/prisma";
import { assertEventScope, requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { assertEventQueryBound, OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import { getResendFrom, useMockIntegrations } from "@/lib/env";
import { canDeliverEmail } from "@/lib/comms/send";
import { orderReminderSessions, selectEligibleSpeakers } from "@/lib/comms/reminders";
import {
  CALENDAR_INVITE_DEFAULT_TEMPLATE,
  CALENDAR_INVITE_TEMPLATE_KEY,
  calendarInviteRequestSchema,
  resolveInviteOrganizer,
  sendCalendarInvites,
  type CalendarInviteSpeaker,
} from "@/lib/comms/calendar-invites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/comms/calendar-invites — send each scheduled speaker a real
 * calendar invitation for their own sessions.
 *
 * Distinct from `POST /api/comms/reminders` on purpose. That route mails a
 * reminder that may carry an informational `.ics`; this one exists to put an
 * entry in the speaker's Gmail/Outlook/iCal calendar, which needs an attendee,
 * an organizer, a per-recipient UID and a revision number that a reminder
 * attachment has no business carrying. Authorization, event scoping, the
 * bounded read and the mock/live branch are all identical to reminders — only
 * the payload differs.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, calendarInviteRequestSchema);
  assertEventScope(ctx, input.eventId);

  const [event, rows] = await Promise.all([
    prisma.event.findUnique({ where: { id: ctx.eventId }, select: { id: true, name: true, timezone: true } }),
    prisma.sessionSpeaker.findMany({
      where: {
        session: {
          eventId: ctx.eventId,
          // An invitation is a promise about the published programme. A talk
          // that is scheduled but held back is not one a speaker should be
          // asked to block their calendar for, and one with no slot has no
          // time to invite them to.
          contentStatus: "PUBLISHED",
          scheduleSlot: { isNot: null },
        },
      },
      select: {
        user: { select: { id: true, name: true, email: true } },
        session: {
          select: {
            id: true,
            title: true,
            description: true,
            scheduleSlot: {
              select: { startsAt: true, endsAt: true, updatedAt: true, room: { select: { name: true } } },
            },
          },
        },
      },
      orderBy: { user: { email: "asc" } },
      take: OPERATOR_QUERY_LIMITS.reminderSessionSpeakers + 1,
    }),
  ]);

  if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found.");
  assertEventQueryBound(
    rows,
    OPERATOR_QUERY_LIMITS.reminderSessionSpeakers,
    "speaker-session rows for calendar invites",
  );

  const grouped = new Map<string, CalendarInviteSpeaker>();
  for (const row of rows) {
    const existing = grouped.get(row.user.id) ?? {
      userId: row.user.id,
      name: row.user.name,
      email: row.user.email,
      sessions: [],
    };
    existing.sessions.push({
      id: row.session.id,
      title: row.session.title,
      description: row.session.description,
      startsAt: row.session.scheduleSlot?.startsAt ?? null,
      endsAt: row.session.scheduleSlot?.endsAt ?? null,
      roomName: row.session.scheduleSlot?.room.name ?? null,
      calendarUpdatedAt: row.session.scheduleSlot?.updatedAt ?? null,
    });
    grouped.set(row.user.id, existing);
  }
  for (const speaker of grouped.values()) {
    // Deterministic VEVENT order, so a retry produces byte-identical bytes and
    // reuses the provider's idempotency key instead of sending twice.
    speaker.sessions = orderReminderSessions(speaker.sessions);
  }

  const { recipients, invalidUserIds } = selectEligibleSpeakers([...grouped.values()], input.recipientUserIds);
  if (invalidUserIds.length > 0) {
    throw new ApiError(422, "RECIPIENT_NOT_ELIGIBLE", "Selected recipients must be scheduled speakers in this event.", {
      recipientUserIds: invalidUserIds,
    });
  }
  if (recipients.length === 0) {
    throw new ApiError(
      422,
      "NO_SCHEDULED_SPEAKERS",
      "No speaker in this event has a published, scheduled session to be invited to.",
    );
  }

  // Its own dispatch parent so the email log can tell an invitation from a
  // reminder. Upserted rather than required, matching the reviewer-invite
  // trigger: an event seeded before this feature existed must not be told to
  // go and create a template row by hand.
  const template = await prisma.emailTemplate.upsert({
    where: { eventId_key: { eventId: ctx.eventId, key: CALENDAR_INVITE_TEMPLATE_KEY } },
    create: { eventId: ctx.eventId, key: CALENDAR_INVITE_TEMPLATE_KEY, ...CALENDAR_INVITE_DEFAULT_TEMPLATE },
    update: {},
    select: { id: true, key: true, subject: true, htmlBody: true },
  });

  const from = getResendFrom();
  // Same decision the reminders route and the operations console make, so the
  // console never promises a delivery this deployment will only record.
  const deliveryMocked = !canDeliverEmail({
    mocked: useMockIntegrations(),
    from,
    apiKey: process.env.RESEND_API_KEY,
  });

  const summary = await sendCalendarInvites(prisma, {
    template,
    speakers: recipients,
    eventName: event.name,
    timeZone: event.timezone,
    organizer: resolveInviteOrganizer(from, process.env.APP_URL),
    appUrl: process.env.APP_URL,
    senderId: ctx.userId,
  });

  // `mocked` is a count of recipients whose message was recorded but never
  // delivered; `deliveryMocked` describes the deployment that produced them.
  return ok({ templateKey: template.key, deliveryMocked, ...summary });
});
