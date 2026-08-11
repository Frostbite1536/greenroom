import { prisma } from "@/lib/prisma";
import { assertEventScope, requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { requireEventOwnedRow } from "@/lib/services/event-owned-row";
import { provisionGuaranteedSession } from "@/lib/services/session-provisioning";
import { readEventRosterMembership } from "@/lib/services/speaker-roster";
import { guaranteedSessionInputSchema, sessionPublicationSchema } from "@/types/api";

export const dynamic = "force-dynamic";

/**
 * POST /api/agenda/sessions — author one talk directly on the programme (admin).
 *
 * The guaranteed session: a keynote, an opening address, a sponsor slot. It has
 * no source proposal, which the schema has always allowed (`sourceAbstractId` is
 * nullable, and the seeded opening keynote is one) and which INV-DOMAIN-001
 * explicitly contemplates — "at most one session per abstract" bounds the
 * proposal path and says nothing about a talk that never had a proposal. Until
 * now nothing could create one at runtime, so an organizer's keynote had to be
 * faked as a proposal and accepted.
 *
 * Every row this writes goes through `provisionGuaranteedSession`, the same
 * provisioning module acceptance uses. The route does not touch `Session` or
 * `SessionSpeaker` itself: the roster snapshot and the onboarding-checklist
 * fan-out (INV-TASK-001) are rules that must not exist in two places.
 *
 * The talk is created `DRAFT`. Creating and announcing are separate acts, and
 * the existing PATCH above is how the second one happens.
 *
 * Locks and authority, in order — a prefix of the C17 sequence, so it cannot
 * cycle with the speaker-administration path that owns the rest of it:
 *   1. `Event` FOR SHARE, the configuration parent, before anything it scopes
 *      (the same first step `POST /api/admin/speakers` and the reviewer-invite
 *      writer take, asserted across all of them in the autoplace contract test);
 *   2. the event-member authority keys and member rows FOR SHARE, inside
 *      `readEventRosterMembership`;
 *   3. the writes.
 *
 * Refusals: 422 for anything the contract rejects; 404 `EVENT_NOT_FOUND` for an
 * event that vanished under the caller; 404 `SPEAKER_NOT_FOUND` for a user id
 * that is not on this event's roster — the same indistinguishable refusal
 * `/api/admin/speakers` gives, so another event's people cannot be enumerated
 * through it. The body's `eventId` must be the signed context's (403
 * `EVENT_SCOPE`, INV-EVENT-001), matching the neighbouring agenda writers.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, guaranteedSessionInputSchema);
  assertEventScope(ctx, input.eventId);

  const created = await prisma.$transaction(async (tx) => {
    const eventRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Event" WHERE "id" = ${ctx.eventId} FOR SHARE
    `;
    if (!eventRows[0]) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found.");

    // Named speakers are authorized against this event's roster under the same
    // union and the same locks the speaker PATCH uses. A user id from another
    // event is the same 404 as an id that does not exist.
    const requested = input.speakers.map((speaker) => speaker.userId);
    const onRoster = await readEventRosterMembership(tx, ctx.eventId, requested);
    if (requested.some((userId) => !onRoster.has(userId))) {
      throw new ApiError(
        404,
        "SPEAKER_NOT_FOUND",
        "Speaker not found.",
        { speakers: ["Choose speakers from this event's roster."] },
      );
    }

    const result = await provisionGuaranteedSession(tx, ctx.eventId, input);
    // Read back from the row that was written, never echoed from the request:
    // the title the organizer sees named in the confirmation is the stored one.
    const session = await tx.session.findUniqueOrThrow({
      where: { id: result.sessionId },
      select: { id: true, title: true, durationMinutes: true, contentStatus: true },
    });
    return { ...result, ...session };
  });

  return ok(created, 201);
});

/**
 * PATCH /api/agenda/sessions — publish or unpublish one talk (admin).
 *
 * The only field this route may write. Scheduling owns placement, decisions own
 * status, and neither is reachable from here: unpublishing is a statement about
 * what the public programme announces, not about whether the talk exists. The
 * row, its slot, its speakers and their tasks are all left exactly as they are,
 * so publishing again restores the same talk to the same place.
 *
 * Event scope comes from the signed ADMIN context and never from the body. An
 * id belonging to another event is the same 404 as an unknown one, so this
 * cannot be used to discover another event's sessions.
 */
export const PATCH = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, sessionPublicationSchema);

  const updated = await prisma.$transaction(async (tx) => {
    // Read the owner inside the same transaction as the write: a session moved
    // or removed between an outside check and the update would otherwise be
    // written by an admin who no longer has authority over it.
    const session = await tx.session.findUnique({
      where: { id: input.sessionId },
      select: { id: true, eventId: true },
    });
    requireEventOwnedRow(session, ctx.eventId, "SESSION_NOT_FOUND", "Session");

    return tx.session.update({
      where: { id: input.sessionId },
      data: { contentStatus: input.contentStatus },
      select: { id: true, title: true, contentStatus: true },
    });
  });

  return ok(updated);
});
