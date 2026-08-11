import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api/http";
import { lockScheduleWrite } from "@/lib/services/schedule-lock";

/**
 * The two write-side decisions of `/api/agenda/slots`, kept pure and injectable
 * so both are asserted against behaviour rather than described in a comment.
 */

/* -------------------------------------------------------------------------- */
/* Candidate identity (GRA-01)                                                 */
/* -------------------------------------------------------------------------- */

export const SLOT_IDENTITY_MISMATCH_CODE = "SLOT_IDENTITY_MISMATCH";
export const SLOT_IDENTITY_MISMATCH_MESSAGE =
  "That slot id does not belong to this session.";

/**
 * Decide which existing slot a placement is allowed to exclude from its own
 * conflict check — and refuse a client that names any other one.
 *
 * `detectConflicts` skips the slot whose id equals the candidate's, so that
 * moving a session does not collide with where it already sits. The candidate
 * id used to be `input.id ?? ownSlot?.id`, taking the request's word for it: a
 * caller who sent **another** session's slot id had that slot silently dropped
 * from the comparison, and the route then answered that the placement was
 * clean. Nothing was escalated — the route is ADMIN-only — but the conflict
 * answer itself was false, which is worse than a refusal because the response
 * looks authoritative.
 *
 * A session has at most one slot (`ScheduleSlot.sessionId` is unique), so the
 * only id a request could legitimately carry is the one the server already
 * holds. Anything else is refused, including an id sent for a session that has
 * no slot at all — such a request has no true id to send. `?force=true` and the
 * "Schedule anyway" conflict-declaration path are untouched: this decides
 * *whose* conflicts are counted, never whether a declared conflict may be
 * recorded.
 *
 * 422 with a precise code follows the route family's convention for a
 * well-formed body that is semantically inadmissible (`NO_PRIMARY_SPEAKER`,
 * `INVALID_CATEGORY`, `RECIPIENT_NOT_ELIGIBLE`); the shape itself is valid, so
 * this is not a `fromZod` refusal.
 */
export function resolveCandidateSlotId(
  requestedId: string | undefined,
  ownSlotId: string | undefined,
): string | undefined {
  if (requestedId !== undefined && requestedId !== ownSlotId) {
    throw new ApiError(422, SLOT_IDENTITY_MISMATCH_CODE, SLOT_IDENTITY_MISMATCH_MESSAGE, {
      id: [SLOT_IDENTITY_MISMATCH_MESSAGE],
    });
  }
  // The server's own answer either way: an omitted id is not a licence to
  // invent one, and a matching id adds nothing to it.
  return ownSlotId;
}

/* -------------------------------------------------------------------------- */
/* Transactional unschedule (GRA-02)                                           */
/* -------------------------------------------------------------------------- */

export const SLOT_NOT_FOUND_CODE = "SLOT_NOT_FOUND";
export const SLOT_NOT_FOUND_MESSAGE = "No schedule slot for this session.";

export type OwnedScheduleSlot = { id: string };

export type ScheduleSlotDeleteDependencies = {
  lockScheduleWrite: typeof lockScheduleWrite;
  findOwnedSlot: (
    tx: Prisma.TransactionClient,
    input: { eventId: string; sessionId: string },
  ) => Promise<OwnedScheduleSlot | null>;
  deleteSlot: (tx: Prisma.TransactionClient, sessionId: string) => Promise<void>;
};

const productionDependencies: ScheduleSlotDeleteDependencies = {
  lockScheduleWrite,
  async findOwnedSlot(tx, { eventId, sessionId }) {
    const slot = await tx.scheduleSlot.findUnique({
      where: { sessionId },
      select: { id: true, session: { select: { eventId: true } } },
    });
    // Unknown and cross-event are the same answer, as before: a caller must not
    // be able to tell another event's session from a nonexistent one.
    return slot && slot.session.eventId === eventId ? { id: slot.id } : null;
  },
  async deleteSlot(tx, sessionId) {
    await tx.scheduleSlot.delete({ where: { sessionId } });
  },
};

/**
 * Unschedule a session under the S3 event lock (`LOCK-ORDER-v1`).
 *
 * This used to be a `findUnique` followed by a `delete` on the base client,
 * with no transaction and no lock — so it was invisible to every other schedule
 * writer. `lockScheduleWrite` names the *event-wide conflict predicate*, not
 * rows, precisely because a row lock cannot cover a slot that does not exist
 * yet; a delete that skips the key can therefore land inside another writer's
 * read-check-write window and remove a slot that writer has already counted, or
 * be counted by a check that then commits against a slot that is gone. The
 * removal was real either way, but the conflict answer given alongside it was
 * computed against a set that no longer existed.
 *
 * Taking `schedule-write:<eventId>` FIRST — the same key, in the same position,
 * as the manual placement POST and bulk auto-placement apply — puts the delete
 * on the same serialization point as every other writer, so the three orderings
 * are decided by the lock rather than by timing. The ownership re-read then
 * happens **under** that lock, so a slot deleted or moved between the check and
 * the delete cannot produce a stale 404 or a stale success.
 *
 * Responses are deliberately unchanged: the same 404 code and message, and the
 * same success payload.
 */
export async function unscheduleSessionSlot(
  tx: Prisma.TransactionClient,
  input: { eventId: string; sessionId: string },
  dependencies: ScheduleSlotDeleteDependencies = productionDependencies,
): Promise<{ sessionId: string; unscheduled: true }> {
  // Step 1 of LOCK-ORDER-v1, and the first statement of the transaction. The
  // delete targets one known slot, so it takes no day keys — the event-wide
  // key is exactly the scope this write invalidates.
  await dependencies.lockScheduleWrite(tx, input.eventId);

  const slot = await dependencies.findOwnedSlot(tx, input);
  if (!slot) throw new ApiError(404, SLOT_NOT_FOUND_CODE, SLOT_NOT_FOUND_MESSAGE);

  await dependencies.deleteSlot(tx, input.sessionId);
  return { sessionId: input.sessionId, unscheduled: true };
}
