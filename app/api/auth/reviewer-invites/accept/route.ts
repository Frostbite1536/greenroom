import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, encodeSession } from "@/lib/auth";
import { ApiError, handle } from "@/lib/api/http";
import { parseBoundedJson } from "@/lib/api/bounded-json";
import { reviewerInviteAcceptSchema } from "@/types/api";
import {
  REVIEWER_INVITE_JSON_MAX_BYTES,
  reviewerInviteSigningSecret,
  trustedReviewerInviteAppUrl,
  verifyReviewerInviteToken,
} from "@/lib/services/reviewer-invite";
import {
  lockEventMemberAuthorities,
  lockExistingEventMembersForShare,
} from "@/lib/services/event-member-lock";

export const dynamic = "force-dynamic";

type InviteLookup = { id: string; eventId: string; userId: string };
type InviteForAccept = InviteLookup & {
  tokenVersion: number;
  expiresAt: Date;
  acceptedVersion: number | null;
};
type SessionRow = { userId: string; userName: string; userEmail: string; eventId: string; eventName: string; eventSlug: string };

function inviteNotFound(): ApiError {
  return new ApiError(404, "INVITE_NOT_FOUND", "Invite not found.");
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

const accept = handle(async (req) => {
  let body: unknown;
  try {
    body = await parseBoundedJson(req, REVIEWER_INVITE_JSON_MAX_BYTES);
  } catch {
    // Never log the request body or bearer: malformed and missing tokens are
    // deliberately indistinguishable at this public boundary.
    console.warn("[reviewer-invite] accept body rejected");
    throw inviteNotFound();
  }
  const parsed = reviewerInviteAcceptSchema.safeParse(body);
  // A malformed bearer body is intentionally indistinguishable from every
  // invalid invite state. There is no invitation or identity lookup yet.
  if (!parsed.success) throw inviteNotFound();
  const secret = reviewerInviteSigningSecret();
  const appUrl = trustedReviewerInviteAppUrl();
  if (!secret || !appUrl) throw new ApiError(503, "INVITE_UNAVAILABLE", "Reviewer invites are temporarily unavailable.");
  const token = verifyReviewerInviteToken(parsed.data.token, secret);
  if (!token) throw inviteNotFound();

  const session = await prisma.$transaction(async (tx) => {
    // Structural/signature verification above is deliberately before this
    // lightweight lookup. All mutable authorization is read after the shared
    // member advisory key and row lock below.
    const lookupRows = await tx.$queryRaw<InviteLookup[]>`
      SELECT "id", "eventId", "userId" FROM "ReviewerInvite" WHERE "id" = ${token.inviteId}
    `;
    const lookup = lookupRows[0];
    if (!lookup) throw inviteNotFound();

    await lockEventMemberAuthorities(tx, [{ eventId: lookup.eventId, userId: lookup.userId }]);
    const members = await lockExistingEventMembersForShare(tx, lookup.eventId, [lookup.userId]);
    if (members[0]?.role !== "EVALUATOR") throw inviteNotFound();

    const inviteRows = await tx.$queryRaw<InviteForAccept[]>`
      SELECT "id", "eventId", "userId", "tokenVersion", "expiresAt", "acceptedVersion"
      FROM "ReviewerInvite"
      WHERE "id" = ${token.inviteId}
      FOR UPDATE
    `;
    const invite = inviteRows[0];
    if (
      !invite ||
      invite.eventId !== lookup.eventId ||
      invite.userId !== lookup.userId ||
      invite.tokenVersion !== token.version ||
      invite.expiresAt.getTime() !== token.expiresAt.getTime() ||
      invite.expiresAt.getTime() <= Date.now() ||
      invite.acceptedVersion === token.version
    ) throw inviteNotFound();

    const updated = await tx.$executeRaw`
      UPDATE "ReviewerInvite"
      SET "acceptedAt" = ${new Date()}, "acceptedVersion" = ${token.version}
      WHERE "id" = ${invite.id} AND "tokenVersion" = ${token.version} AND "acceptedVersion" IS DISTINCT FROM ${token.version}
    `;
    if (updated !== 1) throw inviteNotFound();

    const sessionRows = await tx.$queryRaw<SessionRow[]>`
      SELECT u."id" AS "userId", u."name" AS "userName", u."email" AS "userEmail",
             e."id" AS "eventId", e."name" AS "eventName", e."slug" AS "eventSlug"
      FROM "User" u
      JOIN "Event" e ON e."id" = ${invite.eventId}
      WHERE u."id" = ${invite.userId}
    `;
    const row = sessionRows[0];
    if (!row) throw inviteNotFound();
    return {
      user: { id: row.userId, name: row.userName, email: row.userEmail },
      event: { id: row.eventId, name: row.eventName, slug: row.eventSlug },
      role: "EVALUATOR" as const,
    };
  });

  // Never use the request origin for an authentication redirect: an invite is
  // a bearer capability, so the configured APP_URL is the only trusted base.
  const response = NextResponse.redirect(`${appUrl}/admin/evaluations`, 303);
  response.cookies.set(SESSION_COOKIE, encodeSession(session), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
    secure: process.env.NODE_ENV === "production",
  });
  return response;
});

/** POST only: scanners may fetch a link but cannot consume its fragment bearer. */
export const POST = async (req: Request): Promise<Response> => noStore(await accept(req));
