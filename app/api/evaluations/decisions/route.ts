import { prisma } from "@/lib/prisma";
import { abstractDecisionSchema } from "@/types/api";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { serializeAbstract } from "@/lib/api/abstract-serialize";
import { lockAbstractForWrite } from "@/lib/services/abstract-lock";
import {
  canAdminDecide,
  decisionProvisionsSession,
  decisionTimestamp,
  maybeBlockedByConfirmedSession,
  sessionPublicationForDecision,
} from "@/lib/services/abstract-decision";
import { provisionAcceptedAbstract } from "@/lib/services/session-provisioning";

export const dynamic = "force-dynamic";

/**
 * POST /api/evaluations/decisions — accept, maybe, or reject an abstract (admin).
 *
 * Accepting is the moment a proposal becomes a talk, so it now provisions the
 * whole thing in one locked transaction (WAVE1-B1, director requirement #4):
 * the confirmed `Session` (with its speakers) and every speaker's onboarding
 * checklist. Both steps are idempotent, so re-accepting tops up what is missing
 * instead of duplicating. `/api/evaluations/convert` remains for legacy
 * accepted abstracts without Sessions and for manual checklist backfill.
 *
 * MAYBE is available only before the proposal has a confirmed Session. Once a
 * Session exists, moving back to a review state would split public programme
 * truth and would promise withdrawal while the Session guard correctly blocks
 * it. Existing final-decision reversals still never delete a Session; C10 owns
 * one publication rule across those legacy consumers.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, abstractDecisionSchema);

  // Same per-abstract advisory lock as the speaker PATCH and conversion:
  // every writer that checks-then-writes this abstract serializes here, so a
  // decision cannot interleave with an in-flight speaker edit (and vice
  // versa) between its status read and its write.
  const updated = await prisma.$transaction(async (tx) => {
    await lockAbstractForWrite(tx, input.abstractId);

    const abstract = await tx.abstract.findUnique({
      where: { id: input.abstractId },
      select: { eventId: true, status: true, session: { select: { id: true } } },
    });
    if (!abstract || abstract.eventId !== ctx.eventId) {
      throw new ApiError(404, "ABSTRACT_NOT_FOUND", "Abstract not found.");
    }
    if (!canAdminDecide(abstract.status)) {
      throw new ApiError(409, "ABSTRACT_WITHDRAWN", "This abstract has been withdrawn.");
    }
    if (maybeBlockedByConfirmedSession(input.decision, Boolean(abstract.session))) {
      throw new ApiError(
        409,
        "MAYBE_NOT_AVAILABLE",
        "Maybe is only available before a proposal becomes a confirmed Session.",
      );
    }

    const decided = await tx.abstract.update({
      where: { id: input.abstractId },
      // MAYBE keeps an abstract in review: it carries no final-decision
      // timestamp, can be scored/re-decided later, and never provisions.
      data: { status: input.decision, decidedAt: decisionTimestamp(input.decision, new Date()) },
      include: {
        speakers: { select: { userId: true, isPrimary: true } },
        // `categoryId` so re-accepting can reconcile a topic that moved on the
        // proposal after the talk was created, and `description` so it can
        // reconcile the attendee-facing summary the public programme prints.
        // Both read under the same abstract lock as the write that follows.
        session: { select: { id: true, categoryId: true, description: true } },
      },
    });

    // Rejecting deliberately provisions nothing and removes nothing: an already
    // confirmed session stays on the programme for the admin to unschedule
    // (INV-DOMAIN-001, W2), and its speakers keep any tasks they are working on
    // for other talks.
    const provisioned =
      decisionProvisionsSession(input.decision)
        ? await provisionAcceptedAbstract(tx, decided)
        : {
            sessionId: decided.session?.id ?? null,
            created: false,
            topicReconciled: false,
            summaryReconciled: false,
            tasksAssigned: 0,
          };

    // Nothing is deleted, but a reversed decision must stop speaking publicly.
    // Scoped to this abstract's own Session by its unique `sourceAbstractId`,
    // inside the same advisory lock as the status write, so the public
    // programme can never disagree with the decision that produced it.
    const publication = sessionPublicationForDecision(input.decision);
    if (publication && provisioned.sessionId) {
      await tx.session.update({
        where: { id: provisioned.sessionId },
        data: { contentStatus: publication },
      });
    }

    const full = await tx.abstract.findUniqueOrThrow({
      where: { id: input.abstractId },
      include: {
        category: true,
        speakers: { include: { user: true } },
        session: {
          select: {
            id: true,
            title: true,
            scheduleSlot: {
              select: { startsAt: true, room: { select: { name: true } } },
            },
          },
        },
      },
    });
    return { abstract: full, provisioned };
  });

  const { abstract: decided, provisioned } = updated;
  return ok({
    ...serializeAbstract(decided),
    // Additive keys: existing clients that ignore them are unaffected.
    session: decided.session
      ? {
          id: decided.session.id,
          title: decided.session.title,
          isScheduled: Boolean(decided.session.scheduleSlot),
          scheduledAt: decided.session.scheduleSlot?.startsAt.toISOString() ?? null,
          roomName: decided.session.scheduleSlot?.room.name ?? null,
        }
      : null,
    // What accepting just built, so the UI can confirm it in plain language.
    sessionCreated: provisioned.created,
    tasksAssigned: provisioned.tasksAssigned,
    // Additive: true when re-accepting brought a stale topic back in line.
    topicReconciled: provisioned.topicReconciled,
  });
});
