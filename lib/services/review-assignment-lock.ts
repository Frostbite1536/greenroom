import { Prisma, type AbstractStatus, type UserRole } from "@prisma/client";
import { lockAbstractForWrite } from "@/lib/services/abstract-lock";

export type LockedAssignmentPlan = {
  id: string;
  eventId: string;
};

export type ReviewAssignmentWriteLockDependencies = {
  lockPlan: typeof lockEvaluationPlanForAssignment;
  lockMembers: typeof lockTargetEventMembersForAssignment;
  lockAbstract: typeof lockAbstractForWrite;
};

const productionDependencies: ReviewAssignmentWriteLockDependencies = {
  lockPlan: lockEvaluationPlanForAssignment,
  lockMembers: lockTargetEventMembersForAssignment,
  lockAbstract: lockAbstractForWrite,
};

/** CUID ids are ASCII, so this comparison matches the SQL C-collation lock order. */
export function sortAssignmentLockIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Locks the event-owned parent before the assignment's authority and Abstract
 * classes. FOR SHARE deliberately excludes a concurrent plan or membership
 * update/delete, while allowing another assignment writer to validate the same
 * authority row. The route re-reads all mutable facts after the final lock.
 */
export async function lockEvaluationPlanForAssignment(
  tx: Prisma.TransactionClient,
  planId: string,
): Promise<LockedAssignmentPlan | null> {
  const rows = await tx.$queryRaw<LockedAssignmentPlan[]>`
    SELECT "id", "eventId"
    FROM "EvaluationPlan"
    WHERE "id" = ${planId}
    FOR SHARE
  `;
  return rows[0] ?? null;
}

/**
 * Locks only existing same-event membership rows in bytewise user-id order.
 * Missing rows remain indistinguishable and are rejected by the fresh
 * post-lock authorization read in the assignment route.
 */
export async function lockTargetEventMembersForAssignment(
  tx: Prisma.TransactionClient,
  eventId: string,
  evaluatorIds: readonly string[],
): Promise<void> {
  const sortedIds = sortAssignmentLockIds(evaluatorIds);
  if (sortedIds.length === 0) return;

  await tx.$queryRaw`
    SELECT "userId"
    FROM "EventMember"
    WHERE "eventId" = ${eventId}
      AND "userId" IN (${Prisma.join(sortedIds)})
    ORDER BY "userId" COLLATE "C"
    FOR SHARE
  `;
}

/**
 * Route-specific LOCK-ORDER-v1 sequence for assignment writes:
 * EvaluationPlan FOR SHARE → target EventMember FOR SHARE (bytewise user id)
 * → per-Abstract advisory locks (bytewise id). A missing or cross-event plan
 * stops before the later classes, avoiding locks derived from foreign input.
 */
export async function lockReviewAssignmentWrite(
  tx: Prisma.TransactionClient,
  input: {
    eventId: string;
    planId: string;
    evaluatorIds: readonly string[];
    abstractIds: readonly string[];
  },
  dependencies: ReviewAssignmentWriteLockDependencies = productionDependencies,
): Promise<LockedAssignmentPlan | null> {
  const plan = await dependencies.lockPlan(tx, input.planId);
  if (!plan || plan.eventId !== input.eventId) return plan;

  await dependencies.lockMembers(tx, input.eventId, sortAssignmentLockIds(input.evaluatorIds));
  for (const abstractId of sortAssignmentLockIds(input.abstractIds)) {
    await dependencies.lockAbstract(tx, abstractId);
  }
  return plan;
}

export function isAssignmentEvaluatorRole(role: UserRole): boolean {
  return role === "EVALUATOR" || role === "ADMIN";
}

/** A decision timestamp is terminal even if a malformed legacy row kept a review status. */
export function isAssignmentReviewable(input: { status: AbstractStatus; decidedAt: Date | null }): boolean {
  return (input.status === "SUBMITTED" || input.status === "UNDER_REVIEW") && input.decidedAt === null;
}
