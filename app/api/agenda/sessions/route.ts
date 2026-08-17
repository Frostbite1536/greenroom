import { prisma } from "@/lib/prisma";
import { assertEventScope, requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import {
  AUDITED_SESSION_CONTENT_FIELDS,
  AUDITED_SESSION_PUBLICATION_FIELDS,
  diffChanges,
  recordAudit,
} from "@/lib/services/audit-log";
import { requireEventOwnedRow } from "@/lib/services/event-owned-row";
import { provisionGuaranteedSession } from "@/lib/services/session-provisioning";
import { sessionUpdateData } from "@/lib/services/session-content-edit";
import { readEventRosterMembership } from "@/lib/services/speaker-roster";
import { guaranteedSessionInputSchema, sessionUpdateSchema } from "@/types/api";

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
 * PATCH /api/agenda/sessions — edit one confirmed talk (admin).
 *
 * Publish or unpublish it, and — new — fix its own content: `title`,
 * `description`, `format`, `durationMinutes`, `categoryId`. Sparse: an absent
 * key is left alone, so the one-field publication toggle this route has always
 * served is byte-for-byte the same request it was, and still writes only
 * `contentStatus` (`sessionUpdateSchema` is `sessionPublicationSchema` extended,
 * and `sessionUpdateData` adds no key the body did not name).
 *
 * Why an admin edits content at all. The speaker owns the source `Abstract`
 * (INV-EDIT-001); nobody owned the confirmed talk. A programme committee that
 * accepted a proposal with a typo in its title, a blurb too long for the public
 * page, or the wrong topic label had no way to fix any of it — the speaker could
 * only edit the proposal, which never touches the `Session`. This is that
 * editor, and it is deliberately content-only:
 *
 *   - the **speaker roster stays locked** (INV-EDIT-001). Who presents a
 *     confirmed talk is `POST /api/admin/speakers`' write, under the C17
 *     identity locks, with the onboarding-task fan-out that hangs off it
 *     (INV-TASK-001). It is not a field on a content form.
 *   - **placement stays with scheduling.** Nothing here touches `ScheduleSlot`.
 *   - **decisions stay with decisions.** No `Abstract` row is read or written.
 *
 * INV-SCHEDULE-001 and `durationMinutes`, decided rather than deferred:
 * `ScheduleSlot` stores `startsAt`/`endsAt` outright and `durationMinutes` is
 * not derived from them. `POST /api/agenda/slots` takes both timestamps from its
 * request and never reads the session's length; `detectConflicts`
 * (lib/services/schedule.ts) and `lib/agenda-conflicts.ts` compare slot
 * intervals only — neither mentions `durationMinutes`; the builder's schedule
 * dialog derives `endsAt` from a duration field of its own at placement time. So
 * this write moves no interval and the event's overlap predicate is exactly what
 * it was before it: a duration edit can neither create nor clear a conflict, and
 * needs neither the S3 schedule lock nor a re-check to satisfy the invariant.
 * Re-deriving `endsAt` here is what would be unsafe — that is a placement, and a
 * placement outside a conflict check is precisely what INV-SCHEDULE-001 forbids.
 * A placed talk therefore keeps its slot when its length changes, exactly as it
 * already did when an organizer dragged the block instead, and the dialog says
 * so: resizing on the grid stays the schedule editor's job, where the server
 * re-checks overlap and can refuse. Auto-placement reads the new length for
 * talks it has yet to place, which is the intended effect.
 *
 * Event scope comes from the signed ADMIN context and never from the body. A
 * session id belonging to another event is the same 404 as an unknown one, and
 * so is a `categoryId` — the category is authorized inside the same transaction
 * as the write, by the same `requireEventOwnedRow` the taxonomy routes use, so
 * another event's topics cannot be attached to this event's programme or
 * enumerated through it.
 *
 * Each accepted patch appends one `AuditLogEntry` inside this same transaction
 * (W24, INV-AUDIT-001). A patch that changes `contentStatus` is named `PUBLISH`
 * or `UNPUBLISH` — with any content fields it also moved carried in the same
 * diff — and a content-only edit is named `UPDATE`. A patch that changes
 * nothing records nothing.
 */
export const PATCH = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, sessionUpdateSchema);
  // Which columns move is decided before the transaction opens and cannot grow
  // inside it: the keys here are exactly the ones the body named.
  const data = sessionUpdateData(input);

  const updated = await prisma.$transaction(async (tx) => {
    // Read the owner inside the same transaction as the write — and under the
    // row's own write lock. `FOR UPDATE` does two jobs here: a session moved or
    // removed between an outside check and the update cannot be written by an
    // admin who no longer has authority over it, and a concurrent edit of the
    // same talk queues behind this one instead of reading the same before-state.
    // Without the lock, two simultaneous edits both read A, the second applies
    // over B, and the history records A→C — a transition that never happened,
    // with B orphaned from the trail (INV-AUDIT-001). Every audited column is
    // read here, so the change history's "from" is exactly the value this write
    // replaced.
    const rows = await tx.$queryRaw<
      {
        id: string;
        eventId: string;
        contentStatus: string;
        title: string;
        description: string | null;
        format: string | null;
        durationMinutes: number;
        categoryId: string | null;
      }[]
    >`
      SELECT "id", "eventId", "contentStatus"::text AS "contentStatus", "title",
             "description", "format", "durationMinutes", "categoryId"
      FROM "Session" WHERE "id" = ${input.sessionId} FOR UPDATE
    `;
    const owned = requireEventOwnedRow(rows[0], ctx.eventId, "SESSION_NOT_FOUND", "Session");

    // `null` clears the label and needs no owner. A named id is checked under
    // the same transaction, so a category deleted or moved between an outside
    // check and this update cannot be attached to the talk anyway.
    if (input.categoryId !== undefined && input.categoryId !== null) {
      const category = await tx.category.findUnique({
        where: { id: input.categoryId },
        select: { id: true, eventId: true },
      });
      requireEventOwnedRow(category, ctx.eventId, "CATEGORY_NOT_FOUND", "Category");
    }

    const updated = await tx.session.update({
      where: { id: input.sessionId },
      data,
      // Read back from the row that was written, never echoed from the request.
      // Wider than the old `{ id, title, contentStatus }` projection, which is
      // additive: the toggle's caller reads the same three keys it always did.
      select: {
        id: true,
        title: true,
        description: true,
        format: true,
        durationMinutes: true,
        categoryId: true,
        contentStatus: true,
      },
    });

    // W24 / INV-AUDIT-001: the history row commits with the change it records.
    // Announcing a talk and withdrawing it from the public programme are named
    // separately (`PUBLISH` / `UNPUBLISH`), because "Edited contentStatus" is
    // not what an organizer asks the history about; a content-only edit is the
    // generic `UPDATE`. One row per accepted patch: a request that flips the
    // status and fixes the title carries both in one diff under the act's name.
    // A patch that changes nothing — re-publishing an already published talk,
    // re-saving an unchanged form — records nothing.
    const statusChanged = owned.contentStatus !== updated.contentStatus;
    await recordAudit(tx, {
      eventId: ctx.eventId,
      actorUserId: ctx.userId,
      entityType: "SESSION",
      entityId: updated.id,
      action: statusChanged
        ? (updated.contentStatus === "PUBLISHED" ? "PUBLISH" : "UNPUBLISH")
        : "UPDATE",
      changes: diffChanges(owned, updated, [
        ...AUDITED_SESSION_PUBLICATION_FIELDS,
        ...AUDITED_SESSION_CONTENT_FIELDS,
      ]),
    });

    return updated;
  });

  return ok(updated);
});
