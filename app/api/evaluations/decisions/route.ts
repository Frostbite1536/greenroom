import { prisma } from "@/lib/prisma";
import { abstractDecisionSchema } from "@/types/api";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { serializeAbstract } from "@/lib/api/abstract-serialize";
import { lockAbstractForWrite } from "@/lib/services/abstract-lock";

export const dynamic = "force-dynamic";

/**
 * POST /api/evaluations/decisions — accept or reject an abstract (admin).
 * Records `decidedAt`; conversion to a schedulable Session is a separate,
 * explicit step (`/api/evaluations/convert`) per INV-DOMAIN-001.
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
    if (abstract.status === "WITHDRAWN") {
      throw new ApiError(409, "ABSTRACT_WITHDRAWN", "This abstract has been withdrawn.");
    }

    return tx.abstract.update({
      where: { id: input.abstractId },
      data: { status: input.decision, decidedAt: new Date() },
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
  });

  return ok({
    ...serializeAbstract(updated),
    // Additive key: existing clients that ignore it are unaffected.
    session: updated.session
      ? {
          id: updated.session.id,
          title: updated.session.title,
          isScheduled: Boolean(updated.session.scheduleSlot),
          scheduledAt: updated.session.scheduleSlot?.startsAt.toISOString() ?? null,
          roomName: updated.session.scheduleSlot?.room.name ?? null,
        }
      : null,
  });
});
