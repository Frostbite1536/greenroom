import { prisma } from "@/lib/prisma";
import type { PrismaClient } from "@prisma/client";
import { dispatchEmail, type Fetcher } from "@/lib/comms/send";
import {
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
export type SubmissionNotificationDb = Pick<PrismaClient, "abstract" | "emailTemplate" | "emailDispatch">;

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

/**
 * Deliver exactly one receipt to `Abstract.submitter`. The public writer
 * derives that submitter from its primary roster entry; anonymous input never
 * triggers co-speaker or program-team mail.
 */
export async function notifyAbstractSubmitted(
  abstractId: string,
  options: { fetcher?: Fetcher; db?: SubmissionNotificationDb } = {},
): Promise<NotifySummary> {
  return guard(async () => {
    const db = options.db ?? prisma;
    const abstract = await db.abstract.findUnique({
      where: { id: abstractId },
      select: {
        id: true,
        title: true,
        status: true,
        eventId: true,
        event: { select: { name: true } },
        submitter: { select: { name: true, email: true } },
      },
    });
    // Drafts are not submissions: nobody is told about a proposal in progress.
    if (!abstract || abstract.status === "DRAFT") return { ...EMPTY, skipped: "not_submitted" };

    // Notifications hang off the event's own templates so an operator can see
    // every send in one place; without a template there is nothing to log to.
    const template =
      await db.emailTemplate.findUnique({
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
      await db.emailTemplate.findFirst({
        where: { eventId: abstract.eventId },
        select: { id: true },
        orderBy: { key: "asc" },
      });
    if (!template) return { ...EMPTY, skipped: "no_template" };

    const messages = [{
      ...buildSubmissionReceipt({ eventName: abstract.event.name, speaker: abstract.submitter, title: abstract.title }),
      to: abstract.submitter.email,
    }];

    const summary = { ...EMPTY, attempted: messages.length };
    for (const message of messages) {
      const outcome = await dispatchEmail(db, {
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
