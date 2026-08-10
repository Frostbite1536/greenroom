import { prisma } from "@/lib/prisma";
import { eventCreateSchema } from "@/types/api";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { classifyEventCreateError, planEventCreate } from "@/lib/services/event-create";
import { serializeSettingsEvent } from "@/lib/services/event-settings";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/events — create one empty event (D-C5-9).
 *
 * ADMIN-only, and the creator is made an ADMIN member of the new event in the
 * SAME transaction: an event nobody can administer would be unreachable, and a
 * half-applied create would leave exactly that. There is no delete counterpart
 * in this slice, so a partial write could not be cleaned up through the product.
 *
 * The new event starts genuinely empty — no rooms, tracks, categories or forms
 * are copied from the current one — so every surface shows its existing empty
 * state. Nothing here touches the current event or the public default event.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, eventCreateSchema);
  const data = planEventCreate(input);

  try {
    const created = await prisma.$transaction(async (tx) => {
      const event = await tx.event.create({
        data,
        select: { id: true, name: true, slug: true, timezone: true, startsAt: true, endsAt: true },
      });
      // Same transaction, not a follow-up write: the creator's ADMIN membership
      // is what makes the event administrable at all.
      await tx.eventMember.create({
        data: { eventId: event.id, userId: ctx.userId, role: "ADMIN" },
      });
      return event;
    });
    return ok({ event: serializeSettingsEvent(created) }, 201);
  } catch (error) {
    if (classifyEventCreateError(error) === "EVENT_SLUG_TAKEN") {
      throw new ApiError(409, "EVENT_SLUG_TAKEN", "Another event already uses that web address.", {
        slug: ["This web address is already in use."],
      });
    }
    throw error;
  }
});
