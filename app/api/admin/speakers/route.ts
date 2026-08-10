import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import {
  lockEventMemberAuthorities,
  lockExistingEventMembersForShare,
  lockExistingEventMembersForUpdate,
} from "@/lib/services/event-member-lock";
import { lockPublicSubmissionIdentities } from "@/lib/services/public-submission";
import {
  adminSpeakerCreateSchema,
  adminSpeakerProfilePatchSchema,
  lockSpeakerProfile,
  speakerProfileWriteData,
} from "@/lib/services/speaker-roster";

export const dynamic = "force-dynamic";

/**
 * Organizer speaker administration (SPK-02).
 *
 * ADMIN-only and event-scoped from the signed session, never from the body:
 * no route here accepts an event id, and the caller's own ADMIN authority is
 * re-read from the `EventMember` row under the same transaction that performs
 * the write, so a session that lost its role mid-request cannot slip a write
 * past the entry check (S1).
 *
 * A user id from another event is indistinguishable from an unknown one: both
 * are the same 404, so this endpoint cannot be used to enumerate other events'
 * people.
 *
 * Lock order, narrowing and shared with C17 so the two provisioning paths can
 * never deadlock against each other:
 *   public identity (email) → event-member authority keys → member rows → speaker profile.
 * PATCH addresses a user id directly and therefore never takes the identity key.
 *
 * `User.email` is never written by either handler. Changing a global identity is
 * out of scope by design (S10 uniqueness, C26 recipient derivation).
 */

const profileSelect = {
  bio: true,
  company: true,
  jobTitle: true,
  headshotUrl: true,
  slideDeckUrl: true,
} as const;

/** One indistinguishable refusal for unknown, cross-event, and non-speaker ids. */
function speakerNotFound(): ApiError {
  return new ApiError(404, "SPEAKER_NOT_FOUND", "Speaker not found.");
}

function forbidden(): ApiError {
  return new ApiError(403, "FORBIDDEN", "You do not have access to this resource.");
}

/**
 * POST /api/admin/speakers — add one speaker to this event.
 *
 * Idempotent on (email, event): the account behind the email is reused, the
 * `SPEAKER` membership is created only when absent, and re-sending the same body
 * changes nothing. The existing account's global `name` is preserved, never
 * overwritten by what the organizer typed (C17) — the response reports the
 * stored name back so the UI can say so rather than imply a rename happened.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const { email, name, ...profile } = await parseBody(req, adminSpeakerCreateSchema);
  const profileData = speakerProfileWriteData(profile);

  const result = await prisma.$transaction(async (tx) => {
    const eventRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Event" WHERE "id" = ${ctx.eventId} FOR SHARE
    `;
    if (!eventRows[0]) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found.");

    // The public writer's normalized email identity lock: it closes a
    // simultaneous anonymous co-speaker upsert on the same address.
    await lockPublicSubmissionIdentities(tx, [email]);
    const existing = await tx.user.findUnique({ where: { email }, select: { id: true } });
    const user = await tx.user.upsert({
      where: { email },
      // Empty on purpose. A `User.name` is that person's own, across every
      // event; an organizer adding them here does not get to rewrite it.
      update: {},
      create: { email, name },
      select: { id: true, email: true, name: true },
    });

    await lockEventMemberAuthorities(tx, [
      { eventId: ctx.eventId, userId: ctx.userId },
      { eventId: ctx.eventId, userId: user.id },
    ]);
    const members = await lockExistingEventMembersForUpdate(tx, ctx.eventId, [ctx.userId, user.id]);
    const issuer = members.find((member) => member.userId === ctx.userId);
    if (issuer?.role !== "ADMIN") throw forbidden();

    const target = members.find((member) => member.userId === user.id);
    if (target && target.role !== "SPEAKER") {
      // Demoting an organizer or a reviewer into a speaker is an authority
      // change, and this endpoint has no authority over roles.
      throw new ApiError(
        409,
        "SPEAKER_ROLE_CONFLICT",
        "This person is already an organizer or reviewer on this event, so they cannot be added as a speaker.",
        { email: ["This email already holds another role on this event."] },
      );
    }
    if (!target) {
      await tx.eventMember.create({ data: { eventId: ctx.eventId, userId: user.id, role: "SPEAKER" } });
    }

    // Only what the organizer actually typed. An all-omitted profile leaves any
    // existing row completely untouched rather than creating an empty one.
    if (Object.keys(profileData).length > 0) {
      await lockSpeakerProfile(tx, user.id);
      await tx.speakerProfile.upsert({
        where: { userId: user.id },
        update: profileData,
        create: { userId: user.id, ...profileData },
        select: { id: true },
      });
    }

    return {
      speaker: { userId: user.id, name: user.name, email: user.email },
      requestedName: name,
      userCreated: existing === null,
      membershipCreated: !target,
    };
  });

  return ok(result, result.membershipCreated ? 201 : 200);
});

/**
 * PATCH /api/admin/speakers — edit one speaker's stored profile.
 *
 * Profile fields only. The target must already be on this event's roster, under
 * exactly the union the page renders: an `EventMember(role=SPEAKER)`, or someone
 * on one of this event's sessions (session speakers are created from an accepted
 * abstract's roster and need no membership row of their own). Anyone else — a
 * reviewer, another event's speaker, an id that does not exist — is the same 404.
 */
export const PATCH = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const { userId, ...profile } = await parseBody(req, adminSpeakerProfilePatchSchema);
  const profileData = speakerProfileWriteData(profile);

  const saved = await prisma.$transaction(async (tx) => {
    await lockEventMemberAuthorities(tx, [
      { eventId: ctx.eventId, userId: ctx.userId },
      { eventId: ctx.eventId, userId },
    ]);
    // Shared, not exclusive: no membership row is written here. The rows are
    // still read under their advisory keys so a concurrent C17 insert cannot
    // land in the gap between "no row" and the authorization decision.
    const members = await lockExistingEventMembersForShare(tx, ctx.eventId, [ctx.userId, userId]);
    const issuer = members.find((member) => member.userId === ctx.userId);
    if (issuer?.role !== "ADMIN") throw forbidden();

    const target = members.find((member) => member.userId === userId);
    const onRoster = target?.role === "SPEAKER"
      ? true
      : (await tx.sessionSpeaker.count({
        where: { userId, session: { eventId: ctx.eventId } },
      })) > 0;
    if (!onRoster) throw speakerNotFound();

    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true } });
    if (!user) throw speakerNotFound();

    await lockSpeakerProfile(tx, userId);
    const stored = await tx.speakerProfile.upsert({
      where: { userId },
      update: profileData,
      create: { userId, ...profileData },
      select: profileSelect,
    });

    return { speaker: { userId: user.id, name: user.name, email: user.email }, profile: stored };
  });

  return ok(saved);
});
