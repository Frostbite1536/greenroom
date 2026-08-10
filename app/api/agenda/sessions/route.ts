import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
import { handle, ok, parseBody } from "@/lib/api/http";
import { requireEventOwnedRow } from "@/lib/services/event-owned-row";
import { sessionPublicationSchema } from "@/types/api";

export const dynamic = "force-dynamic";

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
