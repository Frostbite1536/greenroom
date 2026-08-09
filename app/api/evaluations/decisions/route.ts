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
 * Reversing a decision deliberately does NOT delete the Session built from the
 * abstract: the session is the confirmed record, and silently pulling a talk
 * that is already on the public schedule would be worse than leaving it. The
 * response therefore reports the linked session (W2) so the admin UI can say
 * "this talk is still on the programme — unschedule it too".
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

    const abstract = await tx.abstract.findUnique({ where: { id: input.abstractId } });
    if (!abstract || abstract.eventId !== ctx.eventId) {
      throw new ApiError(404, "ABSTRACT_NOT_FOUND", "Abstract not found.");
    }
    if (!canAdminDecide(abstract.status)) {
      throw new ApiError(409, "ABSTRACT_WITHDRAWN", "This abstract has been withdrawn.");
    }

    const decided = await tx.abstract.update({
      where: { id: input.abstractId },
      // MAYBE keeps an abstract in review: it carries no final-decision
      // timestamp, can be scored/re-decided later, and never provisions.
      data: { status: input.decision, decidedAt: decisionTimestamp(input.decision, new Date()) },
      include: { speakers: { select: { userId: true, isPrimary: true } }, session: { select: { id: true } } },
    });

    // Rejecting deliberately provisions nothing and removes nothing: an already
    // confirmed session stays on the programme for the admin to unschedule
    // (INV-DOMAIN-001, W2), and its speakers keep any tasks they are working on
    // for other talks.
    const provisioned =
      decisionProvisionsSession(input.decision)
        ? await provisionAcceptedAbstract(tx, decided)
        : { sessionId: decided.session?.id ?? null, created: false, tasksAssigned: 0 };

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
  });
});
