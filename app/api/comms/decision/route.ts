import { z } from "zod";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { dispatchEmail } from "@/lib/comms/send";
import { buildDecisionEmail } from "@/lib/comms/notifications";
import { issueDecisionPreviewToken, verifyDecisionPreviewToken } from "@/lib/comms/decision-preview";
import { getResendFrom, useMockIntegrations } from "@/lib/env";
import { getServerSigningSecret } from "@/lib/server-signing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const decisionEmailSchema = z.object({
  abstractId: z.string().trim().min(1).max(191),
  /** Preview first: nothing is sent and no dispatch row is written. */
  preview: z.boolean().default(true),
  previewToken: z.string().trim().min(1).max(2_048).optional(),
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
  const decision: "ACCEPTED" | "REJECTED" = abstract.status;

  const feedbackRows = input.includeFeedback
    ? await prisma.reviewScore.findMany({
        where: { abstractId: abstract.id, comment: { not: null } },
        select: { comment: true },
        orderBy: { createdAt: "asc" },
        take: FEEDBACK_LIMIT + 1,
      })
    : [];
  if (feedbackRows.length > FEEDBACK_LIMIT) {
    throw new ApiError(
      422,
      "FEEDBACK_LIMIT_EXCEEDED",
      `This proposal has more than ${FEEDBACK_LIMIT} reviewer comments. Send without comments or reduce the feedback first.`,
    );
  }
  const feedback = feedbackRows
    .map((row) => ({ comment: row.comment?.trim() ?? "" }))
    .filter((row) => row.comment.length > 0);

  // Everyone listed on the proposal hears the outcome, not just the submitter.
  const recipients = [...new Map(
    [abstract.submitter, ...abstract.speakers.map((row) => row.user)].map((person) => [person.email.toLowerCase(), person]),
  ).values()];
  const renderedMessages = recipients.map((speaker) => ({
    recipient: speaker.email,
    ...buildDecisionEmail({
      eventName: abstract.event.name,
      speaker,
      title: abstract.title,
      decision,
      personalNote: input.personalNote,
      feedback,
    }),
  }));
  const previewMail = renderedMessages[0];
  const contentDigest = createHash("sha256")
    .update(JSON.stringify(renderedMessages))
    .digest("base64url");
  const previewIdentity = {
    adminId: ctx.userId,
    eventId: ctx.eventId,
    abstractId: abstract.id,
    contentDigest,
  };
  const signingSecret = getServerSigningSecret();
  if (!signingSecret) {
    throw new ApiError(503, "PREVIEW_UNAVAILABLE", "Decision email preview is unavailable until server signing is configured.");
  }

  if (input.preview) {
    return ok({
      preview: true,
      subject: previewMail.subject,
      html: previewMail.html,
      previewRecipient: abstract.submitter.email,
      recipients: recipients.map((person) => person.email),
      feedbackCount: feedback.length,
      willSend: !useMockIntegrations() && Boolean(process.env.RESEND_API_KEY) && Boolean(getResendFrom()),
      previewToken: issueDecisionPreviewToken(previewIdentity, signingSecret),
    });
  }
  if (!input.previewToken || !verifyDecisionPreviewToken(input.previewToken, previewIdentity, signingSecret)) {
    throw new ApiError(
      409,
      "PREVIEW_REQUIRED",
      "Preview this exact decision email again before sending it.",
    );
  }

  const template = await prisma.emailTemplate.findFirst({
    where: { eventId: abstract.eventId, key: decision === "ACCEPTED" ? "cfp-accepted" : "cfp-rejected" },
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
  for (const mail of renderedMessages) {
    const outcome = await dispatchEmail(prisma, {
      templateId: template.id,
      senderId: ctx.userId,
      message: { to: mail.recipient, subject: mail.subject, html: mail.html },
      variables: { abstractId: abstract.id, kind: "decision", decision },
    });
    if (outcome.status === "sent") sent++;
    else if (outcome.status === "mocked") mocked++;
    else failed++;
  }

  return ok({
    preview: false,
    subject: previewMail.subject,
    recipients: recipients.map((person) => person.email),
    feedbackCount: feedback.length,
    sent,
    mocked,
    failed,
  });
});
