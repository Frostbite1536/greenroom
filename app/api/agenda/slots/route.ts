import { prisma } from "@/lib/prisma";
import { scheduleSlotInputSchema } from "@/types/api";
import { assertEventScope, requireContext } from "@/lib/api/context";
import { ApiError, fail, handle, ok, parseBody } from "@/lib/api/http";
import { detectConflicts, type SlotInterval } from "@/lib/services/schedule";

export const dynamic = "force-dynamic";

/**
 * POST /api/agenda/slots — place (or move) a session on the schedule (admin).
 * Detection and write happen in one transaction (INV-SCHEDULE-001): if a room
 * or speaker overlap is found the write is refused and the conflicts are
 * returned so the UI can explain the collision. Pass `?force=true` to override
 * (records the placement anyway) — used sparingly for the seeded demo conflict.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const force = new URL(req.url).searchParams.get("force") === "true";
  const input = await parseBody(req, scheduleSlotInputSchema);
  assertEventScope(ctx, input.eventId);

  const result = await prisma.$transaction(async (tx) => {
    const session = await tx.session.findUnique({
      where: { id: input.sessionId },
      include: { speakers: { select: { userId: true } } },
    });
    if (!session || session.eventId !== ctx.eventId) {
      throw new ApiError(404, "SESSION_NOT_FOUND", "Session not found.");
    }

    const room = await tx.room.findUnique({ where: { id: input.roomId } });
    if (!room || room.eventId !== ctx.eventId) {
      throw new ApiError(404, "ROOM_NOT_FOUND", "Room not found.");
    }
    if (input.trackId) {
      const track = await tx.track.findUnique({ where: { id: input.trackId } });
      if (!track || track.eventId !== ctx.eventId) {
        throw new ApiError(404, "TRACK_NOT_FOUND", "Track not found.");
      }
    }

    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    const speakerIds = session.speakers.map((s) => s.userId);

    const existingSlots = await tx.scheduleSlot.findMany({
      where: { eventId: ctx.eventId },
      include: { session: { include: { speakers: { select: { userId: true } } } } },
    });
    const intervals: SlotInterval[] = existingSlots.map((slot) => ({
      slotId: slot.id,
      roomId: slot.roomId,
      startsAt: slot.startsAt.getTime(),
      endsAt: slot.endsAt.getTime(),
      speakerIds: slot.session.speakers.map((s) => s.userId),
    }));

    // A session has at most one slot (unique sessionId): treat that as the
    // candidate identity so moving a session doesn't conflict with itself.
    const ownSlot = existingSlots.find((s) => s.sessionId === input.sessionId);
    const conflicts = detectConflicts(
      {
        slotId: input.id ?? ownSlot?.id,
        roomId: input.roomId,
        startsAt: startsAt.getTime(),
        endsAt: endsAt.getTime(),
        speakerIds,
      },
      intervals,
    );

    if (conflicts.length > 0 && !force) {
      return { slot: null, conflicts };
    }

    const slot = await tx.scheduleSlot.upsert({
      where: { sessionId: input.sessionId },
      update: {
        roomId: input.roomId,
        trackId: input.trackId ?? null,
        startsAt,
        endsAt,
      },
      create: {
        eventId: ctx.eventId,
        sessionId: input.sessionId,
        roomId: input.roomId,
        trackId: input.trackId ?? null,
        startsAt,
        endsAt,
      },
    });
    return { slot, conflicts };
  });

  if (!result.slot) {
    return fail(409, "SCHEDULE_CONFLICT", "This placement conflicts with an existing slot.", {
      conflicts: result.conflicts.map((c) => `${c.type}: ${c.message}`),
    });
  }

  return ok({
    slot: {
      id: result.slot.id,
      sessionId: result.slot.sessionId,
      roomId: result.slot.roomId,
      trackId: result.slot.trackId,
      startsAt: result.slot.startsAt.toISOString(),
      endsAt: result.slot.endsAt.toISOString(),
    },
    conflicts: result.conflicts,
  });
});

/** DELETE /api/agenda/slots?sessionId= — unschedule a session (admin). */
export const DELETE = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const sessionId = new URL(req.url).searchParams.get("sessionId");
  if (!sessionId) throw new ApiError(400, "MISSING_SESSION", "sessionId is required.");

  const slot = await prisma.scheduleSlot.findUnique({
    where: { sessionId },
    include: { session: { select: { eventId: true } } },
  });
  if (!slot || slot.session.eventId !== ctx.eventId) {
    throw new ApiError(404, "SLOT_NOT_FOUND", "No schedule slot for this session.");
  }
  await prisma.scheduleSlot.delete({ where: { sessionId } });
  return ok({ sessionId, unscheduled: true });
});
