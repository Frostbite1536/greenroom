import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { reviewerInviteCreateSchema } from "@/types/api";
import { renderEmailTemplate } from "@/lib/comms/reminders";
import { dispatchEmail } from "@/lib/comms/send";
import { missingRequiredTemplateVariables } from "@/lib/comms/template-edit";
import {
  REVIEWER_INVITE_DEFAULT_TEMPLATE,
  REVIEWER_INVITE_TEMPLATE_KEY,
  canReserveReviewerInviteSend,
  createReviewerInviteToken,
  lockReviewerInviteEventHour,
  planReviewerInviteSend,
  reviewerInviteExpiry,
  reviewerInviteUrl,
  reviewerInviteSigningSecret,
  reviewerInviteWindowStart,
  trustedReviewerInviteAppUrl,
} from "@/lib/services/reviewer-invite";
import {
  lockEventMemberAuthorities,
  lockExistingEventMembersForUpdate,
} from "@/lib/services/event-member-lock";
import { lockPublicSubmissionIdentities } from "@/lib/services/public-submission";

export const dynamic = "force-dynamic";

type EventRow = { id: string; name: string; slug: string };
type InviteRow = {
  id: string;
  eventId: string;
  userId: string;
  tokenVersion: number;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedVersion: number | null;
  lastSentAt: Date | null;
  sendWindowStart: Date | null;
  sendWindowCount: number;
  lastDeliveryState: "PENDING" | "SENT" | "MOCKED" | "FAILED";
  lastDeliveryAt: Date | null;
};

type DeliveryWork = {
  inviteId: string;
  tokenVersion: number;
  expiresAt: Date;
  template: { id: string; subject: string; htmlBody: string };
  recipient: { email: string; name: string };
  eventName: string;
  token: string;
};

function inviteView(invite: InviteRow | null, state: "pending" | "invited" | "active", delivery?: string) {
  return {
    state,
    access: "active" as const,
    expiresAt: invite?.expiresAt ?? null,
    delivery: delivery ?? (invite ? invite.lastDeliveryState.toLowerCase() : "not_sent"),
  };
}

function rateLimited(): ApiError {
  return new ApiError(429, "INVITE_RATE_LIMITED", "This event has reached its reviewer invite send limit. Try again in the next hour.");
}

/**
 * POST /api/evaluations/reviewer-invites — provision or renew one evaluator.
 * The signed ADMIN context supplies the only event authority; email is an
 * identity lookup, never an authority id. Broad rate → Event → public identity
 * → member keys/rows → invite row is the C17 lock order and never joins an
 * Abstract lock.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, reviewerInviteCreateSchema);
  const secret = reviewerInviteSigningSecret();
  const appUrl = trustedReviewerInviteAppUrl();
  if (!secret || !appUrl) {
    throw new ApiError(503, "INVITE_UNAVAILABLE", "Reviewer invites are temporarily unavailable.");
  }

  const now = new Date();
  const windowStart = reviewerInviteWindowStart(now);
  const planned = await prisma.$transaction(async (tx) => {
    // Broad predicate keys always come first. This reservation is durable even
    // if the later mock/provider attempt fails after commit.
    await lockReviewerInviteEventHour(tx, ctx.eventId, windowStart);
    const eventRows = await tx.$queryRaw<EventRow[]>`
      SELECT "id", "name", "slug" FROM "Event" WHERE "id" = ${ctx.eventId} FOR SHARE
    `;
    const event = eventRows[0];
    if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found.");

    // This is the public writer's normalized email identity lock. It closes a
    // simultaneous anonymous roster/User upsert without mutating its name.
    await lockPublicSubmissionIdentities(tx, [input.email]);
    const user = await tx.user.upsert({
      where: { email: input.email },
      update: {},
      create: { email: input.email, name: input.name },
      select: { id: true, email: true, name: true },
    });

    await lockEventMemberAuthorities(tx, [
      { eventId: ctx.eventId, userId: ctx.userId },
      { eventId: ctx.eventId, userId: user.id },
    ]);
    const members = await lockExistingEventMembersForUpdate(tx, ctx.eventId, [ctx.userId, user.id]);
    const issuer = members.find((member) => member.userId === ctx.userId);
    if (issuer?.role !== "ADMIN") throw new ApiError(403, "FORBIDDEN", "You do not have access to this resource.");
    const target = members.find((member) => member.userId === user.id);
    if (target?.role === "SPEAKER") {
      throw new ApiError(409, "REVIEWER_ROLE_CONFLICT", "This event member is already a speaker.");
    }
    if (target?.role === "ADMIN") return { response: inviteView(null, "active"), delivery: null as DeliveryWork | null };

    const existingRows = await tx.$queryRaw<InviteRow[]>`
      SELECT "id", "eventId", "userId", "tokenVersion", "expiresAt", "acceptedAt", "acceptedVersion",
             "lastSentAt", "sendWindowStart", "sendWindowCount", "lastDeliveryState", "lastDeliveryAt"
      FROM "ReviewerInvite"
      WHERE "eventId" = ${ctx.eventId} AND "userId" = ${user.id}
      FOR UPDATE
    `;
    const existing = existingRows[0] ?? null;
    const sendPlan = planReviewerInviteSend(existing, { resend: input.resend, now, windowStart });
    if (sendPlan.kind === "active") {
      return { response: inviteView(existing, "active"), delivery: null as DeliveryWork | null };
    }
    if (sendPlan.kind === "pending") {
      return { response: inviteView(existing, "pending"), delivery: null as DeliveryWork | null };
    }
    if (sendPlan.kind === "cooldown") {
      throw new ApiError(429, "INVITE_RESEND_COOLDOWN", "Wait ten minutes before resending this reviewer invite.");
    }

    // A manually-created or legacy row may predate the template PATCH guard.
    // Ensure its stored, editable truth remains deliverable before consuming a
    // rate reservation or rotating the bearer token.
    const ensuredTemplate = await tx.emailTemplate.upsert({
      where: { eventId_key: { eventId: ctx.eventId, key: REVIEWER_INVITE_TEMPLATE_KEY } },
      create: { eventId: ctx.eventId, key: REVIEWER_INVITE_TEMPLATE_KEY, ...REVIEWER_INVITE_DEFAULT_TEMPLATE },
      update: {},
      select: { id: true, subject: true, htmlBody: true },
    });
    const lockedTemplateRows = await tx.$queryRaw<{ id: string; subject: string; htmlBody: string }[]>`
      SELECT "id", "subject", "htmlBody" FROM "EmailTemplate" WHERE "id" = ${ensuredTemplate.id} FOR SHARE
    `;
    const template = lockedTemplateRows[0];
    if (!template) throw new ApiError(422, "INVALID_INVITE_TEMPLATE", "Reviewer invite template is unavailable.");
    const missingTemplateVariables = missingRequiredTemplateVariables(
      REVIEWER_INVITE_TEMPLATE_KEY,
      template.subject,
      template.htmlBody,
    );
    if (missingTemplateVariables.length > 0) {
      throw new ApiError(
        422,
        "INVALID_INVITE_TEMPLATE",
        `This reviewer invite template must include ${missingTemplateVariables.map((variable) => `{{${variable}}}`).join(", ")}.`,
      );
    }

    const countRows = await tx.$queryRaw<{ count: bigint | number }[]>`
      SELECT COALESCE(SUM("sendWindowCount"), 0) AS "count"
      FROM "ReviewerInvite"
      WHERE "eventId" = ${ctx.eventId} AND "sendWindowStart" = ${windowStart}
    `;
    if (!canReserveReviewerInviteSend(Number(countRows[0]?.count ?? 0))) throw rateLimited();

    const expiresAt = reviewerInviteExpiry(now);
    const { tokenVersion, sendWindowCount } = sendPlan;
    let invite: InviteRow;
    if (existing) {
      const updated = await tx.$queryRaw<InviteRow[]>`
        UPDATE "ReviewerInvite"
        SET "tokenVersion" = ${tokenVersion}, "expiresAt" = ${expiresAt}, "acceptedAt" = NULL,
            "acceptedVersion" = NULL, "lastSentAt" = ${now}, "sendWindowStart" = ${windowStart},
            "sendWindowCount" = ${sendWindowCount}, "lastDeliveryState" = 'PENDING', "lastDeliveryAt" = NULL
        WHERE "id" = ${existing.id}
        RETURNING "id", "eventId", "userId", "tokenVersion", "expiresAt", "acceptedAt", "acceptedVersion",
                  "lastSentAt", "sendWindowStart", "sendWindowCount", "lastDeliveryState", "lastDeliveryAt"
      `;
      invite = updated[0]!;
    } else {
      const inserted = await tx.$queryRaw<InviteRow[]>`
        INSERT INTO "ReviewerInvite" (
          "id", "eventId", "userId", "tokenVersion", "expiresAt", "lastSentAt", "sendWindowStart", "sendWindowCount"
        ) VALUES (
          ${randomUUID()}, ${ctx.eventId}, ${user.id}, ${tokenVersion}, ${expiresAt}, ${now}, ${windowStart}, 1
        )
        RETURNING "id", "eventId", "userId", "tokenVersion", "expiresAt", "acceptedAt", "acceptedVersion",
                  "lastSentAt", "sendWindowStart", "sendWindowCount", "lastDeliveryState", "lastDeliveryAt"
      `;
      invite = inserted[0]!;
    }

    if (!target) {
      await tx.eventMember.create({ data: { eventId: ctx.eventId, userId: user.id, role: "EVALUATOR" } });
    }
    const token = createReviewerInviteToken({ inviteId: invite.id, version: invite.tokenVersion, expiresAt: invite.expiresAt }, secret);
    return {
      response: inviteView(invite, "invited", "pending"),
      delivery: { inviteId: invite.id, tokenVersion: invite.tokenVersion, expiresAt: invite.expiresAt, template, recipient: user, eventName: event.name, token } satisfies DeliveryWork,
    };
  });

  if (!planned.delivery) return ok(planned.response);
  const rendered = renderEmailTemplate(planned.delivery.template, {
    reviewerName: planned.delivery.recipient.name,
    eventName: planned.delivery.eventName,
    // The bearer appears only in the outgoing rendered email, never dispatch variables.
    inviteUrl: reviewerInviteUrl(appUrl, planned.delivery.token),
  });
  const outcome = await dispatchEmail(prisma, {
    templateId: planned.delivery.template.id,
    senderId: ctx.userId,
    message: { to: planned.delivery.recipient.email, ...rendered },
    variables: { kind: "reviewer_invite", eventName: planned.delivery.eventName },
  });
  const deliveryState = outcome.status.toUpperCase() as "SENT" | "MOCKED" | "FAILED";
  await prisma.$executeRaw`
    UPDATE "ReviewerInvite"
    SET "lastDeliveryState" = ${deliveryState}, "lastDeliveryAt" = ${new Date()}
    WHERE "id" = ${planned.delivery.inviteId}
      AND "tokenVersion" = ${planned.delivery.tokenVersion}
      AND "expiresAt" = ${planned.delivery.expiresAt}
      AND "acceptedAt" IS NULL
  `;
  return ok({ ...planned.response, delivery: outcome.status });
});
