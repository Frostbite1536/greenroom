import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
import { handle, ok } from "@/lib/api/http";
import { OPERATOR_QUERY_LIMITS, assertEventQueryBound } from "@/lib/api/query-limits";
import { isReviewerInvitePending } from "@/lib/services/reviewer-invite";

export const dynamic = "force-dynamic";

type InviteListRow = {
  userId: string;
  tokenVersion: number;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedVersion: number | null;
  lastSentAt: Date | null;
  lastDeliveryState: "PENDING" | "SENT" | "MOCKED" | "FAILED";
};

/**
 * GET /api/evaluations/evaluators — event members who can review (admin).
 *
 * The assignment UI needs real `User` ids to POST
 * `/api/evaluations/assignments`, but persona cookies only carry emails and
 * ids are server-generated. This is the only supported way to resolve them.
 * Includes ADMINs since admins commonly review alongside the evaluator team.
 * Scoped to the caller's active event (INV-EVENT-001).
 */
export const GET = handle(async () => {
  const ctx = await requireContext(["ADMIN"]);

  const members = await prisma.eventMember.findMany({
    where: { eventId: ctx.eventId, role: { in: ["EVALUATOR", "ADMIN"] } },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { user: { name: "asc" } },
    take: OPERATOR_QUERY_LIMITS.reviewerSetupMembers + 1,
  });
  assertEventQueryBound(members, OPERATOR_QUERY_LIMITS.reviewerSetupMembers, "reviewer setup members");
  const userIds = members.map((member) => member.userId);
  const invites = userIds.length === 0
    ? []
    : await prisma.$queryRaw<InviteListRow[]>`
      SELECT "userId", "tokenVersion", "expiresAt", "acceptedAt", "acceptedVersion", "lastSentAt", "lastDeliveryState"
      FROM "ReviewerInvite"
      WHERE "eventId" = ${ctx.eventId} AND "userId" IN (${Prisma.join(userIds)})
    `;
  const inviteByUserId = new Map(invites.map((invite) => [invite.userId, invite]));

  return ok(
    members.map((m) => {
      const invite = inviteByUserId.get(m.userId) ?? null;
      return {
        userId: m.user.id,
        name: m.user.name,
        email: m.user.email,
        role: m.role,
        access: "active" as const,
        invite: invite
          ? {
              state: isReviewerInvitePending(invite) ? "pending" : invite.acceptedVersion === invite.tokenVersion ? "accepted" : "expired",
              expiresAt: invite.expiresAt,
              lastSentAt: invite.lastSentAt,
              delivery: invite.lastDeliveryState.toLowerCase(),
            }
          : null,
      };
    }),
  );
});
