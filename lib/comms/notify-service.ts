import { prisma } from "@/lib/prisma";
import type { PrismaClient } from "@prisma/client";
import { dispatchEmail, type Fetcher } from "@/lib/comms/send";
import {
  buildSubmissionReceipt,
  CFP_SUBMITTED_TEMPLATE_KEY,
} from "@/lib/comms/notifications";
import { renderEmailTemplate } from "@/lib/comms/reminders";
import { submissionReceiptVariables } from "@/lib/comms/template-truth";
import { storedTemplateDefects } from "@/lib/comms/template-edit";

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
    const dedicated = await db.emailTemplate.findUnique({
      where: {
        eventId_key: {
          eventId: abstract.eventId,
          key: CFP_SUBMITTED_TEMPLATE_KEY,
        },
      },
      select: { id: true, subject: true, htmlBody: true },
    });
    const template =
      dedicated ??
      // Compatibility for an already-running event between this code deploy
      // and its next coordinated reseed. This row is the required dispatch-log
      // parent ONLY: it may be any template the event happens to have, so
      // rendering the receipt from it could mail an acceptance notice to
      // someone who has merely submitted. Fixed copy is the safe answer here.
      (await db.emailTemplate.findFirst({
        where: { eventId: abstract.eventId },
        select: { id: true, subject: true, htmlBody: true },
        orderBy: { key: "asc" },
      }));
    if (!template) return { ...EMPTY, skipped: "no_template" };

    // C21: the stored `cfp-submitted` template genuinely drives this send, so
    // the operator console's claim that editing it changes the receipt is true.
    //
    // But a stored row is only trustworthy if it passed the edit contract, and
    // a row edited before this template became load-bearing never did — nothing
    // validated it, because nothing rendered it. Re-check it here against the
    // very same predicate `PATCH /api/comms/templates/:id` applies, so a legacy
    // row cannot mail a receipt full of blank substitutions or literal braces.
    // Validation is not a fork of the edit rules; it is those rules.
    const receiptVariables = submissionReceiptVariables({
      eventName: abstract.event.name,
      speakerName: abstract.submitter.name,
      title: abstract.title,
    });
    const storedDefects = dedicated
      ? storedTemplateDefects({
          key: CFP_SUBMITTED_TEMPLATE_KEY,
          subject: dedicated.subject ?? "",
          htmlBody: dedicated.htmlBody ?? "",
          suppliedVariables: Object.keys(receiptVariables),
        })
      : [];
    const usesStoredTemplate = Boolean(dedicated) && storedDefects.length === 0;
    const content = usesStoredTemplate && dedicated
      ? renderEmailTemplate({ subject: dedicated.subject, htmlBody: dedicated.htmlBody }, receiptVariables)
      : buildSubmissionReceipt({ eventName: abstract.event.name, speaker: abstract.submitter, title: abstract.title });
    // Never claim the template drove a send it did not. The audit row carries
    // why the fixed builder produced these bytes, using the closed defect codes.
    const fallbackReason = usesStoredTemplate
      ? null
      : dedicated
        ? storedDefects.join(",")
        : "no_receipt_template";

    const messages = [{ ...content, to: abstract.submitter.email }];

    const summary = { ...EMPTY, attempted: messages.length };
    for (const message of messages) {
      const outcome = await dispatchEmail(db, {
        templateId: template.id,
        message: { to: message.to, subject: message.subject, html: message.html },
        // `source` records which wording produced this message, so the audit
        // log can distinguish a stored-template receipt from the fallback.
        variables: {
          abstractId: abstract.id,
          kind: "submission",
          source: usesStoredTemplate ? "template" : "fixed",
          ...(fallbackReason ? { fallbackReason } : {}),
        },
        fetcher: options.fetcher,
      });
      if (outcome.status === "sent") summary.sent++;
      else if (outcome.status === "mocked") summary.mocked++;
      else summary.failed++;
    }
    return summary;
  });
}
