import { prisma } from "@/lib/prisma";
import { dispatchEmail, type Fetcher } from "@/lib/comms/send";
import {
  buildCoSpeakerNotice,
  buildSubmissionAlert,
  buildSubmissionReceipt,
  CFP_SUBMITTED_TEMPLATE_KEY,
} from "@/lib/comms/notifications";

/**
 * Submission notifications (requirements delta #2, answer 6 / audit1#10).
 *
 * Deliberately **never throws**. A CFP submission must succeed even if the mail
 * provider is down — losing a speaker's proposal because an email failed would
 * be a far worse bug than a missing notification. Failures are recorded on the
 * `EmailDispatch` row and returned in the summary.
 *
 * The call site is one awaited line, not fire-and-forget: on serverless, work
 * that outlives the response is not guaranteed to run.
 */
export type NotifySummary = { attempted: number; sent: number; mocked: number; failed: number; skipped?: string };

const EMPTY: NotifySummary = { attempted: 0, sent: 0, mocked: 0, failed: 0 };

/** Anything that must never break the caller runs inside this. */
async function guard(run: () => Promise<NotifySummary>): Promise<NotifySummary> {
  try {
    return await run();
  } catch (error) {
    console.error("[comms] notification failed", error);
    return { ...EMPTY, skipped: "notification_error" };
  }
}

const ADMIN_ALERT_LIMIT = 10;

/**
 * Tell the submitter, their co-speakers, and the program team that a proposal
 * arrived. Idempotent enough for practical use: it is called once per submit.
 */
export async function notifyAbstractSubmitted(
  abstractId: string,
  options: { fetcher?: Fetcher } = {},
): Promise<NotifySummary> {
  return guard(async () => {
    const abstract = await prisma.abstract.findUnique({
      where: { id: abstractId },
      select: {
        id: true,
        title: true,
        status: true,
        eventId: true,
        event: { select: { name: true } },
        category: { select: { name: true } },
        submitter: { select: { name: true, email: true } },
        speakers: {
          select: { isPrimary: true, user: { select: { name: true, email: true } } },
          take: 25,
        },
      },
    });
    // Drafts are not submissions: nobody is told about a proposal in progress.
    if (!abstract || abstract.status === "DRAFT") return { ...EMPTY, skipped: "not_submitted" };

    // Notifications hang off the event's own templates so an operator can see
    // every send in one place; without a template there is nothing to log to.
    const template =
      await prisma.emailTemplate.findUnique({
        where: {
          eventId_key: {
            eventId: abstract.eventId,
            key: CFP_SUBMITTED_TEMPLATE_KEY,
          },
        },
        select: { id: true },
      }) ??
      // Compatibility for an already-running event between this code deploy
      // and its next coordinated reseed. The rendered submission messages do
      // not come from this row; it is the required dispatch-log parent only.
      // Prefer the dedicated key as soon as it exists, but do not silently
      // suppress receipts while legacy event templates are still in place.
      await prisma.emailTemplate.findFirst({
        where: { eventId: abstract.eventId },
        select: { id: true },
        orderBy: { key: "asc" },
      });
    if (!template) return { ...EMPTY, skipped: "no_template" };

    const speakers = abstract.speakers.map((row) => row.user);
    const admins = await prisma.eventMember.findMany({
      where: { eventId: abstract.eventId, role: "ADMIN" },
      select: { user: { select: { name: true, email: true } } },
      take: ADMIN_ALERT_LIMIT,
    });

    const messages = [
      buildSubmissionReceipt({
        eventName: abstract.event.name,
        speaker: abstract.submitter,
        title: abstract.title,
        coSpeakers: speakers,
      }),
    ].map((mail) => ({ ...mail, to: abstract.submitter.email }));

    for (const person of speakers) {
      if (person.email.toLowerCase() === abstract.submitter.email.toLowerCase()) continue;
      const mail = buildCoSpeakerNotice({
        eventName: abstract.event.name,
        coSpeaker: person,
        submitter: abstract.submitter,
        title: abstract.title,
      });
      messages.push({ ...mail, to: person.email });
    }

    for (const admin of admins) {
      const mail = buildSubmissionAlert({
        eventName: abstract.event.name,
        adminName: admin.user.name,
        title: abstract.title,
        speakers,
        categoryName: abstract.category?.name ?? null,
      });
      messages.push({ ...mail, to: admin.user.email });
    }

    const summary = { ...EMPTY, attempted: messages.length };
    for (const message of messages) {
      const outcome = await dispatchEmail(prisma, {
        templateId: template.id,
        message: { to: message.to, subject: message.subject, html: message.html },
        variables: { abstractId: abstract.id, kind: "submission" },
        fetcher: options.fetcher,
      });
      if (outcome.status === "sent") summary.sent++;
      else if (outcome.status === "mocked") summary.mocked++;
      else summary.failed++;
    }
    return summary;
  });
}
