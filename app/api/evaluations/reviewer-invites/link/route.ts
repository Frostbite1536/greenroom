import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { reviewerInviteLinkSchema } from "@/types/api";
import {
  createReviewerInviteToken,
  isReviewerInvitePending,
  reviewerInviteSigningSecret,
  reviewerInviteUrl,
  trustedReviewerInviteAppUrl,
} from "@/lib/services/reviewer-invite";
import {
  lockEventMemberAuthorities,
  lockExistingEventMembersForShare,
} from "@/lib/services/event-member-lock";

export const dynamic = "force-dynamic";

type InviteForReveal = {
  id: string;
  tokenVersion: number;
  expiresAt: Date;
  acceptedVersion: number | null;
};

function inviteNotFound(): ApiError {
  return new ApiError(404, "INVITE_NOT_FOUND", "Invite not found.");
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

/**
 * POST /api/evaluations/reviewer-invites/link — show one pending reviewer's
 * invite link to the event ADMIN who already provisioned it.
 *
 * A deployment without a mail provider records the invitation as `mocked` and
 * delivers nothing (C19 owns durable delivery), so without this an invited
 * reviewer has no way in at all. C17's never-persist/never-project rule is
 * kept intact: the bearer is still stored nowhere, absent from every listing
 * projection, and never logged. It is re-derived here at request time from the
 * persisted invite id/version/expiry — the same domain-separated derivation
 * the C17 pending-retry path already relies on — returned once in a no-store
 * body, and then forgotten by the server.
 *
 * The reveal predicate is deliberately the acceptance predicate: the same
 * shared member-authority lock, the same EVALUATOR membership requirement, and
 * a still-pending invite. It can therefore never surface a bearer that
 * `/api/auth/reviewer-invites/accept` would refuse, and it consumes nothing —
 * single use, replay, revocation, rotation, and expiry all remain enforced by
 * `tokenVersion`/`acceptedVersion`/`expiresAt` at acceptance time.
 *
 * This widens no authority. The caller is already an ADMIN of this event, can
 * already provision and rotate this invite, and the revealed bearer grants
 * strictly less than the session it is issued from: EVALUATOR access to this
 * one event.
 */
const reveal = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, reviewerInviteLinkSchema);
  const secret = reviewerInviteSigningSecret();
  const appUrl = trustedReviewerInviteAppUrl();
  if (!secret || !appUrl) {
    throw new ApiError(503, "INVITE_UNAVAILABLE", "Reviewer invites are temporarily unavailable.");
  }

  const invite = await prisma.$transaction(async (tx) => {
    // Read-only throughout: a reveal reserves no send window, writes no
    // dispatch row, and never touches invite lifecycle state.
    const user = await tx.user.findUnique({ where: { email: input.email }, select: { id: true } });
    if (!user) throw inviteNotFound();

    await lockEventMemberAuthorities(tx, [
      { eventId: ctx.eventId, userId: ctx.userId },
      { eventId: ctx.eventId, userId: user.id },
    ]);
    const members = await lockExistingEventMembersForShare(tx, ctx.eventId, [ctx.userId, user.id]);
    if (members.find((member) => member.userId === ctx.userId)?.role !== "ADMIN") {
      throw new ApiError(403, "FORBIDDEN", "You do not have access to this resource.");
    }
    // A reviewer whose role changed under us is refused exactly as acceptance
    // refuses them; another event's reviewer simply has no row here.
    if (members.find((member) => member.userId === user.id)?.role !== "EVALUATOR") throw inviteNotFound();

    const rows = await tx.$queryRaw<InviteForReveal[]>`
      SELECT "id", "tokenVersion", "expiresAt", "acceptedVersion"
      FROM "ReviewerInvite"
      WHERE "eventId" = ${ctx.eventId} AND "userId" = ${user.id}
      FOR SHARE
    `;
    const row = rows[0];
    // Accepted, already-consumed, and expired invites are all refused: only a
    // still-pending invite has a bearer acceptance would honour.
    if (!row || !isReviewerInvitePending(row)) throw inviteNotFound();
    return row;
  });

  const token = createReviewerInviteToken(
    { inviteId: invite.id, version: invite.tokenVersion, expiresAt: invite.expiresAt },
    secret,
  );
  // The bearer exists only in this response. It is never echoed into a log
  // line, a dispatch variable, or any listing projection.
  return ok({ inviteUrl: reviewerInviteUrl(appUrl, token), expiresAt: invite.expiresAt });
});

/** POST only, and no-store on every outcome: a bearer must never be cached. */
export const POST = async (req: Request): Promise<Response> => noStore(await reveal(req));
