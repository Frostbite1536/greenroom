import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import {
  lockEventMemberAuthorities,
  lockExistingEventMembersForUpdate,
} from "@/lib/services/event-member-lock";
import { lockPublicSubmissionIdentities } from "@/lib/services/public-submission";
import {
  countActiveAssignments,
  countEventAdmins,
  decideMemberRemoval,
  decideRoleChange,
  eventTeamAddSchema,
  eventTeamRoleChangeSchema,
  lockEventTeam,
} from "@/lib/services/event-team";

export const dynamic = "force-dynamic";

/**
 * Event team administration — the write half of `/admin/team`.
 *
 * ADMIN-only and event-scoped from the signed session, never from the body: no
 * handler here accepts an event id, and the caller's own ADMIN authority is
 * re-read from the `EventMember` row under the same transaction that performs
 * the write, so a session that lost its role mid-request cannot slip a write
 * past the entry check (S1).
 *
 * A user id from another event is indistinguishable from an unknown one: both
 * are the same 404, so this endpoint cannot enumerate other events' people.
 *
 * Lock order, narrowing and compatible with C17 so the three provisioning paths
 * can never deadlock against each other:
 *   event team key → Event → public identity (email) → event-member authority
 *   keys → member rows.
 * The event team key is new and broader than anything C17 takes; nothing
 * outside `lib/services/event-team.ts` acquires it, so no path can be waiting
 * on it in the opposite order. It is what makes the last-ADMIN count safe:
 * that rule is a predicate over the whole event, and per-member keys cannot
 * hold it (two concurrent demotions of two different admins would each see two).
 * PATCH and DELETE address a user id directly and therefore never take the
 * identity key.
 *
 * `User.email` and `User.name` are never written by any handler here. Changing
 * a global identity is out of scope by design (S10 uniqueness, C26 recipient
 * derivation), exactly as on the speaker path.
 *
 * No notification email is sent. The reviewer-invite template is a *bearer
 * link* shape, and there is no honest equivalent here: a newly provisioned
 * account cannot sign in at all (see `TEAM_NEW_ACCOUNT_NOTE`), so a "you have
 * been added" mail would point somebody at a door that does not open for them.
 * Rather than bolt on a new mail shape to say something untrue, the surface
 * tells the organizer what to do instead.
 */

/** One indistinguishable refusal for unknown, cross-event, and non-member ids. */
function memberNotFound(): ApiError {
  return new ApiError(404, "TEAM_MEMBER_NOT_FOUND", "Team member not found.");
}

function forbidden(): ApiError {
  return new ApiError(403, "FORBIDDEN", "You do not have access to this resource.");
}

/**
 * Facts every guard needs, all read after the member rows are locked and inside
 * the transaction that writes. Read together so no refusal is decided against a
 * count taken at a different moment than another.
 */
async function readGuardFacts(
  tx: Prisma.TransactionClient,
  eventId: string,
  userId: string,
) {
  const [adminCount, activeAssignments, sessionCount, taskCount] = await Promise.all([
    countEventAdmins(tx, eventId),
    countActiveAssignments(tx, eventId, userId),
    tx.sessionSpeaker.count({ where: { userId, session: { eventId } } }),
    tx.speakerTask.count({ where: { userId, task: { eventId } } }),
  ]);
  return { adminCount, activeAssignments, sessionCount, taskCount };
}

/**
 * POST /api/admin/team — add one organizer or reviewer to this event.
 *
 * Idempotent on (email, event) for the same role: the account behind the email
 * is reused, the membership is created only when absent, and re-sending the
 * same body changes nothing. The existing account's global `name` is preserved,
 * never overwritten by what the organizer typed (C17) — the response reports
 * the stored name back so the UI can say so rather than imply a rename.
 *
 * An email that already holds a DIFFERENT role is refused rather than silently
 * moved. Changing somebody's authority is PATCH's job, where the last-organizer
 * and open-assignment guards apply; letting an add do it quietly would route a
 * demotion around both.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const { email, name, role } = await parseBody(req, eventTeamAddSchema);

  const result = await prisma.$transaction(async (tx) => {
    await lockEventTeam(tx, ctx.eventId);
    const eventRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Event" WHERE "id" = ${ctx.eventId} FOR SHARE
    `;
    if (!eventRows[0]) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found.");

    // The public writer's normalized email identity lock: it closes a
    // simultaneous anonymous co-speaker upsert on the same address. Same key,
    // same position in the order, as `/api/admin/speakers`.
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
    if (target && target.role !== role) {
      throw new ApiError(
        409,
        "TEAM_ROLE_CONFLICT",
        "This person is already on this event with a different role. Change their role from the team list instead.",
        { email: ["This email already holds another role on this event."] },
      );
    }
    if (!target) {
      await tx.eventMember.create({ data: { eventId: ctx.eventId, userId: user.id, role } });
    }

    return {
      member: { userId: user.id, name: user.name, email: user.email, role },
      requestedName: name,
      userCreated: existing === null,
      membershipCreated: !target,
    };
  });

  return ok(result, result.membershipCreated ? 201 : 200);
});

/**
 * PATCH /api/admin/team — change one member's role on this event.
 *
 * Every refusal is a named 422 decided by `decideRoleChange` from counts taken
 * inside this transaction, after the member rows are locked. A caller demoting
 * themselves is the same code path as demoting anyone else: they are refused
 * only when they are the last organizer, and then for that reason.
 */
export const PATCH = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const { userId, role } = await parseBody(req, eventTeamRoleChangeSchema);

  const saved = await prisma.$transaction(async (tx) => {
    await lockEventTeam(tx, ctx.eventId);
    await lockEventMemberAuthorities(tx, [
      { eventId: ctx.eventId, userId: ctx.userId },
      { eventId: ctx.eventId, userId },
    ]);
    const members = await lockExistingEventMembersForUpdate(tx, ctx.eventId, [ctx.userId, userId]);
    const issuer = members.find((member) => member.userId === ctx.userId);
    if (issuer?.role !== "ADMIN") throw forbidden();

    const target = members.find((member) => member.userId === userId);
    if (!target) throw memberNotFound();
    if (target.role === role) {
      return { member: { userId, role: target.role }, changed: false };
    }

    const facts = await readGuardFacts(tx, ctx.eventId, userId);
    const decision = decideRoleChange({
      current: target.role,
      next: role,
      adminCount: facts.adminCount,
      activeAssignments: facts.activeAssignments,
      self: userId === ctx.userId,
    });
    if (!decision.allowed) throw new ApiError(422, decision.code, decision.message);

    const updated = await tx.eventMember.update({
      where: { eventId_userId: { eventId: ctx.eventId, userId } },
      data: { role },
      select: { userId: true, role: true },
    });
    return { member: updated, changed: true, previousRole: target.role };
  });

  return ok(saved);
});

/**
 * DELETE /api/admin/team?userId=… — remove one member from this event.
 *
 * The user id rides in the query string, matching the other operator deletes
 * (`/api/admin/settings/rooms`, `/api/admin/tasks`). Only the `EventMember` row
 * is deleted: the `User`, their global profile, their sessions and their tasks
 * are not this event's to destroy, which is exactly why a speaker who still has
 * programme work is refused instead of half-removed.
 */
export const DELETE = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const userId = new URL(req.url).searchParams.get("userId");
  if (!userId) throw new ApiError(400, "MISSING_USER", "userId is required.");

  const removed = await prisma.$transaction(async (tx) => {
    await lockEventTeam(tx, ctx.eventId);
    await lockEventMemberAuthorities(tx, [
      { eventId: ctx.eventId, userId: ctx.userId },
      { eventId: ctx.eventId, userId },
    ]);
    const members = await lockExistingEventMembersForUpdate(tx, ctx.eventId, [ctx.userId, userId]);
    const issuer = members.find((member) => member.userId === ctx.userId);
    if (issuer?.role !== "ADMIN") throw forbidden();

    const target = members.find((member) => member.userId === userId);
    if (!target) throw memberNotFound();

    const facts = await readGuardFacts(tx, ctx.eventId, userId);
    const decision = decideMemberRemoval({
      role: target.role,
      adminCount: facts.adminCount,
      activeAssignments: facts.activeAssignments,
      sessionCount: facts.sessionCount,
      taskCount: facts.taskCount,
      self: userId === ctx.userId,
    });
    if (!decision.allowed) throw new ApiError(422, decision.code, decision.message);

    await tx.eventMember.delete({ where: { eventId_userId: { eventId: ctx.eventId, userId } } });
    return { member: { userId, role: target.role } };
  });

  return ok(removed);
});
