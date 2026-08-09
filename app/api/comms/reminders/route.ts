import { prisma } from "@/lib/prisma";
import { assertEventScope, requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { assertEventQueryBound, OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import { getResendFrom, useMockIntegrations } from "@/lib/env";
import { canDeliverEmail, dispatchEmail } from "@/lib/comms/send";
import {
  buildSpeakerCalendarInvite,
  reminderRequestSchema,
  renderEmailTemplate,
  selectEligibleSpeakers,
  type EligibleSpeaker,
} from "@/lib/comms/reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function formatSlotTime(startsAt: Date | null): string {
  return startsAt ? startsAt.toISOString().replace("T", " ").replace(".000Z", " UTC") : "a time to be announced";
}

/** POST /api/comms/reminders — dispatch one event-scoped template per selected or eligible speaker. */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, reminderRequestSchema);
  assertEventScope(ctx, input.eventId);

  const [event, template, rows] = await Promise.all([
    prisma.event.findUnique({ where: { id: ctx.eventId }, select: { id: true, name: true, startsAt: true } }),
    prisma.emailTemplate.findFirst({
      where: { eventId: ctx.eventId, key: input.templateKey },
      select: { id: true, key: true, subject: true, htmlBody: true },
    }),
    prisma.sessionSpeaker.findMany({
      where: { session: { eventId: ctx.eventId } },
      select: {
        user: { select: { id: true, name: true, email: true, taskAssignments: {
          where: { task: { eventId: ctx.eventId }, status: { notIn: ["COMPLETED", "WAIVED"] } },
          select: { taskId: true },
          take: OPERATOR_QUERY_LIMITS.openTasksPerReminderSpeaker + 1,
        } } },
        session: { select: {
          id: true, title: true, description: true,
          scheduleSlot: { select: { startsAt: true, endsAt: true, updatedAt: true, room: { select: { name: true } } } },
        } },
      },
      orderBy: { user: { email: "asc" } },
      take: OPERATOR_QUERY_LIMITS.reminderSessionSpeakers + 1,
    }),
  ]);

  if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found.");
  if (!template) throw new ApiError(404, "TEMPLATE_NOT_FOUND", "That template does not exist for this event.");
  assertEventQueryBound(
    rows,
    OPERATOR_QUERY_LIMITS.reminderSessionSpeakers,
    "speaker-session rows for reminders",
  );
  for (const row of rows) {
    assertEventQueryBound(
      row.user.taskAssignments,
      OPERATOR_QUERY_LIMITS.openTasksPerReminderSpeaker,
      `open tasks for speaker '${row.user.id}'`,
    );
  }

  const grouped = new Map<string, EligibleSpeaker>();
  for (const row of rows) {
    const existing = grouped.get(row.user.id) ?? {
      userId: row.user.id,
      name: row.user.name,
      email: row.user.email,
      openTasks: row.user.taskAssignments.length,
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

  const { recipients, invalidUserIds } = selectEligibleSpeakers([...grouped.values()], input.recipientUserIds);
  if (invalidUserIds.length > 0) {
    throw new ApiError(422, "RECIPIENT_NOT_ELIGIBLE", "Selected recipients must be speakers in this event.", {
      recipientUserIds: invalidUserIds,
    });
  }
  if (recipients.length === 0) throw new ApiError(422, "NO_ELIGIBLE_RECIPIENTS", "This event has no eligible speakers.");

  // Delivery, mock fallback and EmailDispatch bookkeeping live in one audited
  // place (`lib/comms/send.ts`) shared with submission and decision emails.
  const isMock = !canDeliverEmail({
    mocked: useMockIntegrations(),
    from: getResendFrom(),
    apiKey: process.env.RESEND_API_KEY,
  });
  const appUrl = process.env.APP_URL;
  let sent = 0;
  let failed = 0;

  for (const recipient of recipients) {
    const primarySession = recipient.sessions.find((session) => session.startsAt) ?? recipient.sessions[0];
    const variables = {
      ...input.variables,
      speakerName: recipient.name,
      eventName: event.name,
      openTasks: String(recipient.openTasks),
      dueDate: event.startsAt ? event.startsAt.toISOString().slice(0, 10) : "the event",
      talkTitle: primarySession?.title ?? "your session",
      slotTime: formatSlotTime(primarySession?.startsAt ?? null),
      roomName: primarySession?.roomName ?? "the venue",
    };
    const rendered = renderEmailTemplate(template, variables);
    const invite = input.includeCalendarInvite ? buildSpeakerCalendarInvite(recipient, event.name, appUrl) : null;

    const outcome = await dispatchEmail(prisma, {
      templateId: template.id,
      senderId: ctx.userId,
      message: {
        to: recipient.email,
        subject: rendered.subject,
        html: rendered.html,
        ...(invite ? { attachments: [{ filename: invite.filename, content: invite.content }] } : {}),
      },
      variables,
    });
    if (outcome.status === "failed") failed++;
    else sent++;
  }

  return ok({ templateKey: template.key, recipientCount: recipients.length, sent, failed, mocked: isMock });
});
