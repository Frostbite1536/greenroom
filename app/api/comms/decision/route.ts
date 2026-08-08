import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { dispatchEmail } from "@/lib/comms/send";
import { buildDecisionEmail } from "@/lib/comms/notifications";
import { useMockIntegrations } from "@/lib/env";
import { getResendFrom } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const decisionEmailSchema = z.object({
  abstractId: z.string().trim().min(1).max(191),
  /** Preview first: nothing is sent and no dispatch row is written. */
  preview: z.boolean().default(true),
  includeFeedback: z.boolean().default(true),
  personalNote: z.string().trim().max(4_000).nullish(),
});

const FEEDBACK_LIMIT = 50;

/**
 * POST /api/comms/decision — email a speaker their decision, optionally with
 * the review team's written feedback (requirements delta #2, answer 3).
 *
 * ADMIN-only and event-scoped. Preview is the default, because this is the one
 * email in the product that a speaker reads at their most invested — an
 * operator should always see it before it goes.
 *
 * Only decided abstracts qualify: emailing someone about a proposal still under
 * review would be worse than not emailing at all.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, decisionEmailSchema);

  const abstract = await prisma.abstract.findUnique({
    where: { id: input.abstractId },
    select: {
      id: true,
      eventId: true,
      title: true,
      status: true,
      event: { select: { name: true } },
      submitter: { select: { name: true, email: true } },
      speakers: { select: { user: { select: { name: true, email: true } } }, take: 25 },
    },
  });
  if (!abstract || abstract.eventId !== ctx.eventId) {
    throw new ApiError(404, "ABSTRACT_NOT_FOUND", "That proposal does not exist for this event.");
  }
  if (abstract.status !== "ACCEPTED" && abstract.status !== "REJECTED") {
    throw new ApiError(
      409,
      "NOT_DECIDED",
      "Decide this proposal first — a speaker should not hear from us while it is still under review.",
    );
  }

  const feedback = input.includeFeedback
    ? (await prisma.reviewScore.findMany({
        where: { abstractId: abstract.id, comment: { not: null } },
        select: { comment: true },
        orderBy: { createdAt: "asc" },
        take: FEEDBACK_LIMIT,
      })).map((row) => ({ comment: row.comment ?? "" }))
    : [];

  const mail = buildDecisionEmail({
    eventName: abstract.event.name,
    speaker: abstract.submitter,
    title: abstract.title,
    decision: abstract.status,
    personalNote: input.personalNote,
    feedback,
  });

  // Everyone listed on the proposal hears the outcome, not just the submitter.
  const recipients = [...new Map(
    [abstract.submitter, ...abstract.speakers.map((row) => row.user)].map((person) => [person.email.toLowerCase(), person]),
  ).values()];

  if (input.preview) {
    return ok({
      preview: true,
      subject: mail.subject,
      html: mail.html,
      recipients: recipients.map((person) => person.email),
      feedbackCount: feedback.length,
      willSend: !useMockIntegrations() && Boolean(process.env.RESEND_API_KEY) && Boolean(getResendFrom()),
    });
  }

  const template = await prisma.emailTemplate.findFirst({
    where: { eventId: abstract.eventId, key: abstract.status === "ACCEPTED" ? "cfp-accepted" : "cfp-rejected" },
    select: { id: true },
  }) ?? await prisma.emailTemplate.findFirst({
    where: { eventId: abstract.eventId },
    select: { id: true },
    orderBy: { key: "asc" },
  });
  if (!template) {
    throw new ApiError(409, "NO_TEMPLATE", "This event has no email templates to record the send against.");
  }

  let sent = 0;
  let mocked = 0;
  let failed = 0;
  for (const person of recipients) {
    const outcome = await dispatchEmail(prisma, {
      templateId: template.id,
      senderId: ctx.userId,
      message: { to: person.email, subject: mail.subject, html: mail.html },
      variables: { abstractId: abstract.id, kind: "decision", decision: abstract.status },
    });
    if (outcome.status === "sent") sent++;
    else if (outcome.status === "mocked") mocked++;
    else failed++;
  }

  return ok({
    preview: false,
    subject: mail.subject,
    recipients: recipients.map((person) => person.email),
    feedbackCount: feedback.length,
    sent,
    mocked,
    failed,
  });
});
