import { z } from "zod";
import type { EvaluationAssignmentStatus, Prisma, UserRole } from "@prisma/client";
import { idSchema } from "@/types/api";
import { TEAM_ADDABLE_ROLES, TEAM_ASSIGNABLE_ROLES } from "@/lib/team/roles";

/**
 * Event team administration for `/admin/team` — the admin surface of
 * INV-EVENT-001.
 *
 * Until now `EventMember` rows were only ever created, in exactly three places
 * (event creation → founding ADMIN, `/api/admin/speakers` → SPEAKER,
 * `/api/evaluations/reviewer-invites` → EVALUATOR) and never updated or
 * deleted. This module owns the first surface that changes and removes them, so
 * everything that made "role lives in `EventMember`, re-resolved per request"
 * safe has to keep holding while the row itself moves.
 *
 * Three properties define it.
 *
 * **An event must never lose its last ADMIN.** That is not a validation rule
 * over one row; it is a count over the event, so it cannot be decided outside
 * the transaction that writes. `eventTeamLockKey` serializes every team write
 * for one event precisely because per-member authority keys do not: two
 * concurrent demotions of two *different* admins each lock only their own
 * target, each read "2 admins", and between them leave zero.
 *
 * **Authority does not carry across events.** No handler accepts an event id;
 * the signed ADMIN context is the only one, and a target is addressed by user
 * id which is then authorized against *this* event's membership. A user id
 * belonging to another event is therefore indistinguishable from one that does
 * not exist — the same 404.
 *
 * **Identity is written by exactly one writer.** Adding a member by email
 * reuses the account behind that address and never rewrites its global `name`,
 * under the same C17 lock order the speaker path takes
 * (`app/api/admin/speakers/route.ts`): public identity (email) → event-member
 * authority keys → member rows. This module introduces no second identity
 * writer; it adds one *broader* key ahead of that sequence, which keeps the
 * acquisition order narrowing and cycle-free.
 *
 * The role list, ordering rule and organizer-facing copy live in
 * `lib/team/roles.ts`, which the browser also imports. Keeping the Zod
 * contracts and lock helpers here means the validator never ships to a client
 * that only needs a label.
 */

/**
 * Review work that still blocks a role change or a removal.
 *
 * COMPLETED and DECLINED assignments are history: the scores are recorded and
 * nothing is owed, so they must not pin somebody to a role forever. The same
 * two statuses that `WITHDRAWAL_OPEN_ASSIGNMENT_STATUSES` (speaker withdrawal)
 * and `CONFLICT_DECLINABLE_STATUSES` (conflict declaration) call open — kept as
 * its own named constant per concern, exactly as those two are, rather than one
 * shared list that would tie three unrelated policies together.
 */
export const TEAM_BLOCKING_ASSIGNMENT_STATUSES = [
  "ASSIGNED",
  "IN_PROGRESS",
] as const satisfies readonly EvaluationAssignmentStatus[];

/**
 * Roles that can hold a `ReviewAssignment`. Mirrors `isAssignmentEvaluatorRole`
 * in `lib/services/review-assignment-lock.ts`, which is what the assignment
 * writer itself enforces — so promoting a reviewer to organizer keeps their
 * queue valid and is never refused for it.
 */
export function roleCanHoldAssignments(role: UserRole): boolean {
  return role === "EVALUATOR" || role === "ADMIN";
}

/**
 * POST body: no event id, no authority id — the signed ADMIN context is both.
 *
 * There is deliberately no `name`. This surface never creates a `User` (see
 * `NO_ACCOUNT_FOR_EMAIL`), so there is no row a typed name could land in, and
 * `.strict()` makes sending one a validation failure rather than a silently
 * ignored field — a client can never believe it named or renamed anybody here.
 * The address resolves to an account that already has its own name, and the
 * response reports that stored name back.
 */
export const eventTeamAddSchema = z
  .object({
    // Normalized identically to the speaker and reviewer-invite contracts, so
    // the three provisioning surfaces resolve one address to one account.
    email: z.string().trim().toLowerCase().max(254).email(),
    role: z.enum(TEAM_ADDABLE_ROLES),
  })
  .strict();

export type EventTeamAdd = z.infer<typeof eventTeamAddSchema>;

/**
 * Adding an address with no account is refused, not provisioned.
 *
 * The speaker and reviewer-invite paths both upsert a shell `User` for an
 * unknown address, and for them that is sound: a speaker is reachable through
 * the organizer and a reviewer receives a signed bearer link that signs them in
 * without a password. A team member has neither. A shell account here would be
 * one **nobody could ever sign in to**, and worse, one that permanently blocks
 * the only fix:
 *
 * - `/api/auth/forgot` cannot help it. The reset token is signed over a digest
 *   of the credential a `User` currently stores, so an account holding none has
 *   nothing to sign against; the route returns early and sends no mail.
 * - `/api/auth/signup` cannot help it either. It answers an address that
 *   already has a `User` row with a 409 — and the shell row would be exactly
 *   that. Creating it takes away the person's own way in.
 *
 * Nothing in this codebase deletes a `User`, so that trap would be permanent.
 * Refusing costs an organizer one message to the person they are adding;
 * provisioning costs that person their account. The refusal names the order
 * that works, which is the one `/welcome` and `/api/auth/continue` were built
 * for: they sign up first, then the organizer adds the same address.
 *
 * What this does disclose to an event ADMIN: whether an address has an account.
 * That is not new — the speaker path already reports `userCreated` to the same
 * audience — and it is why the refusal is raised only AFTER the caller's stored
 * ADMIN authority has been re-read under the write's own lock.
 */
export const NO_ACCOUNT_FOR_EMAIL = "NO_ACCOUNT_FOR_EMAIL";

export const NO_ACCOUNT_FOR_EMAIL_MESSAGE =
  "No Greenroom account uses that email address, and creating one from here would leave them unable to sign "
  + "in: a new account has no password, “Forgot password” only mails accounts that already have one, and the "
  + "empty account would then block them from signing up themselves. Ask them to sign up at /signup first, "
  + "then add the same address here — they will land in this event the next time they sign in.";

/**
 * PATCH body. `userId` addresses the row and is authorized against this event's
 * membership server-side, never trusted. `.strict()` means sending an `email`
 * or a `name` is a validation failure rather than a silently ignored field: a
 * client can never believe it renamed somebody from here.
 */
export const eventTeamRoleChangeSchema = z
  .object({
    userId: idSchema,
    role: z.enum(TEAM_ASSIGNABLE_ROLES),
  })
  .strict();

export type EventTeamRoleChange = z.infer<typeof eventTeamRoleChangeSchema>;

/* ------------------------------------------------------------------ */
/* Serialization                                                       */
/* ------------------------------------------------------------------ */

/**
 * The event-wide serializing key for team writes.
 *
 * Broader than the per-member authority keys and therefore taken strictly
 * before them, matching the "broad predicate keys always come first" order the
 * reviewer-invite route states. It exists for one reason: the last-ADMIN rule
 * is a predicate over the whole event, and no per-row lock can hold it. Nothing
 * outside this module's callers takes this key, so no other path can be waiting
 * on it in the opposite order — the sequence stays cycle-free.
 */
export function eventTeamLockKey(eventId: string): string {
  return `event-team:${eventId}`;
}

export async function lockEventTeam(tx: Prisma.TransactionClient, eventId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${eventTeamLockKey(eventId)}, 0))`;
}

/**
 * How many ADMINs this event has, read inside the write's own transaction and
 * under `eventTeamLockKey`. A pre-flight count outside the transaction could be
 * two when it was read and one when the write landed.
 */
export async function countEventAdmins(
  tx: Prisma.TransactionClient,
  eventId: string,
): Promise<number> {
  return tx.eventMember.count({ where: { eventId, role: "ADMIN" } });
}

/**
 * Assignments in this event that this person still owes. Keyed through
 * `EvaluationPlan.eventId`, because `ReviewAssignment` has no event column of
 * its own — an evaluator's queue on *another* event is none of this event's
 * business and must not block a change here.
 */
export async function countActiveAssignments(
  tx: Prisma.TransactionClient,
  eventId: string,
  userId: string,
): Promise<number> {
  return tx.reviewAssignment.count({
    where: {
      evaluatorId: userId,
      plan: { eventId },
      status: { in: [...TEAM_BLOCKING_ASSIGNMENT_STATUSES] },
    },
  });
}

/* ------------------------------------------------------------------ */
/* Refusals                                                            */
/* ------------------------------------------------------------------ */

export const LAST_ADMIN = "LAST_ADMIN";
export const EVALUATOR_HAS_ASSIGNMENTS = "EVALUATOR_HAS_ASSIGNMENTS";
export const SPEAKER_HAS_PROGRAMME_WORK = "SPEAKER_HAS_PROGRAMME_WORK";

export type TeamRefusal = {
  code: typeof LAST_ADMIN | typeof EVALUATOR_HAS_ASSIGNMENTS | typeof SPEAKER_HAS_PROGRAMME_WORK;
  message: string;
};

export type TeamDecision = { allowed: true } | ({ allowed: false } & TeamRefusal);

const ALLOWED: TeamDecision = { allowed: true };

/**
 * The last organizer may not be demoted or removed — including by themselves.
 *
 * There is no recovery if this is allowed to happen: an event with no ADMIN has
 * no surface that can grant one back, because granting one requires being one.
 * The refusal names the way out rather than only saying no.
 */
function lastAdminRefusal(self: boolean): TeamRefusal {
  return {
    code: LAST_ADMIN,
    message: self
      ? "You are the only organizer on this event. Add another organizer first — if you step down now, nobody could add one back."
      : "This is the only organizer on this event. Add another organizer first — with none, nobody could add one back.",
  };
}

function assignmentRefusal(count: number, removing: boolean): TeamRefusal {
  return {
    code: EVALUATOR_HAS_ASSIGNMENTS,
    message:
      `${count} proposal${count === 1 ? " is" : "s are"} still assigned to this reviewer. `
      + `Reassign ${count === 1 ? "it" : "them"} from Evaluations, then ${removing ? "remove them" : "change their role"}.`,
  };
}

/**
 * A speaker with programme work is not removable, because removing the
 * membership row would not actually remove them from the programme.
 *
 * `/admin/speakers` renders a *union* of `EventMember(role=SPEAKER)` and
 * `SessionSpeaker` (see `lib/speakers/roster-read.ts`), and `SpeakerTask` is
 * keyed on `(taskId, userId)` with no membership involved. Deleting the
 * membership therefore leaves the sessions on the schedule, the tasks in the
 * checklist, and the person still on the roster — a half-removal that reads as
 * a bug. Refusing and naming what is in the way is the honest outcome; the
 * organizer's real lever is the session or the task itself.
 *
 * A role CHANGE away from speaker is deliberately not gated the same way:
 * nothing there is deleted, the sessions and tasks stay keyed to the same user,
 * and the roster still lists them through `SessionSpeaker`. Only the removal
 * destroys a row, so only the removal has to refuse.
 */
function programmeWorkRefusal(sessions: number, tasks: number): TeamRefusal {
  const parts: string[] = [];
  if (sessions > 0) parts.push(`${sessions} session${sessions === 1 ? "" : "s"}`);
  if (tasks > 0) parts.push(`${tasks} onboarding task${tasks === 1 ? "" : "s"}`);
  return {
    code: SPEAKER_HAS_PROGRAMME_WORK,
    message:
      `This speaker still has ${parts.join(" and ")} on this event. Removing them here would not take them `
      + "off the programme — clear that work from Agenda builder and Speaker onboarding first.",
  };
}

export type RoleChangeFacts = {
  /** The role stored right now, re-read under the write's own lock. */
  current: UserRole;
  next: UserRole;
  /** ADMINs on this event, counted in the same transaction. */
  adminCount: number;
  /** Assignments this person still owes on this event. */
  activeAssignments: number;
  /** True when the caller is changing their own role. */
  self: boolean;
};

/**
 * Whether a role change may proceed. Pure: the route supplies these facts only
 * after it has taken the event key, locked the member rows, and re-read every
 * one of them inside the transaction that writes.
 */
export function decideRoleChange(facts: RoleChangeFacts): TeamDecision {
  if (facts.current === facts.next) return ALLOWED;

  // Losing the last organizer. Checked first: it is the only refusal that
  // cannot be worked around by tidying data, so it is the honest one to lead
  // with when more than one applies.
  if (facts.current === "ADMIN" && facts.next !== "ADMIN" && facts.adminCount <= 1) {
    return { allowed: false, ...lastAdminRefusal(facts.self) };
  }

  // Only a move OUT of the assignment-capable roles strands a queue.
  // EVALUATOR → ADMIN keeps every assignment valid, so it is never refused.
  if (
    roleCanHoldAssignments(facts.current)
    && !roleCanHoldAssignments(facts.next)
    && facts.activeAssignments > 0
  ) {
    return { allowed: false, ...assignmentRefusal(facts.activeAssignments, false) };
  }

  return ALLOWED;
}

export type RemovalFacts = {
  role: UserRole;
  adminCount: number;
  activeAssignments: number;
  /** Sessions on THIS event that list this person as a speaker. */
  sessionCount: number;
  /** Onboarding-task assignments on THIS event. */
  taskCount: number;
  self: boolean;
};

/** Whether a member may be removed. Same discipline as `decideRoleChange`. */
export function decideMemberRemoval(facts: RemovalFacts): TeamDecision {
  if (facts.role === "ADMIN" && facts.adminCount <= 1) {
    return { allowed: false, ...lastAdminRefusal(facts.self) };
  }
  if (roleCanHoldAssignments(facts.role) && facts.activeAssignments > 0) {
    return { allowed: false, ...assignmentRefusal(facts.activeAssignments, true) };
  }
  if (facts.role === "SPEAKER" && (facts.sessionCount > 0 || facts.taskCount > 0)) {
    return { allowed: false, ...programmeWorkRefusal(facts.sessionCount, facts.taskCount) };
  }
  return ALLOWED;
}
