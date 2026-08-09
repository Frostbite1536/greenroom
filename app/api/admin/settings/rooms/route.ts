import { prisma } from "@/lib/prisma";
import { roomCreateSchema, roomUpdateSchema } from "@/types/api";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { assertEventQueryBound, OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import { decideRoomDeletion } from "@/lib/services/room-deletion";
import { classifyRoomMutationError } from "@/lib/services/room-mutation-errors";

export const dynamic = "force-dynamic";

const roomOrder = [{ sortOrder: "asc" as const }, { name: "asc" as const }, { id: "asc" as const }];
const roomSelect = { id: true, name: true, capacity: true, sortOrder: true } as const;

/** GET /api/admin/settings/rooms — active-event rooms, stable for settings UI. */
export const GET = handle(async () => {
  const ctx = await requireContext(["ADMIN"]);
  const rooms = await prisma.room.findMany({
    where: { eventId: ctx.eventId },
    orderBy: roomOrder,
    take: OPERATOR_QUERY_LIMITS.settingsRooms + 1,
    select: roomSelect,
  });
  assertEventQueryBound(rooms, OPERATOR_QUERY_LIMITS.settingsRooms, "rooms in event settings");
  return ok({ rooms });
});

/** POST /api/admin/settings/rooms — add a room to the active event. */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, roomCreateSchema);
  try {
    const room = await prisma.room.create({
      data: {
        eventId: ctx.eventId,
        name: input.name,
        capacity: input.capacity ?? null,
        sortOrder: input.sortOrder ?? 0,
      },
      select: roomSelect,
    });
    return ok({ room }, 201);
  } catch (error) {
    if (classifyRoomMutationError(error) === "ROOM_NAME_TAKEN") {
      throw new ApiError(409, "ROOM_NAME_TAKEN", "Another room in this event already uses that name.", {
        name: ["This room name is already in use."],
      });
    }
    throw error;
  }
});

/** PATCH /api/admin/settings/rooms — update a room only after active-event scope check. */
export const PATCH = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, roomUpdateSchema);
  const existing = await prisma.room.findFirst({ where: { id: input.id, eventId: ctx.eventId }, select: { id: true } });
  if (!existing) throw new ApiError(404, "ROOM_NOT_FOUND", "Room not found.");

  try {
    const room = await prisma.room.update({
      where: { id: existing.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      },
      select: roomSelect,
    });
    return ok({ room });
  } catch (error) {
    const mutationError = classifyRoomMutationError(error);
    if (mutationError === "ROOM_NAME_TAKEN") {
      throw new ApiError(409, "ROOM_NAME_TAKEN", "Another room in this event already uses that name.", {
        name: ["This room name is already in use."],
      });
    }
    // The scoped preflight may be invalidated by a concurrent delete. Keep
    // that race indistinguishable from an unknown or cross-event room ID.
    if (mutationError === "ROOM_NOT_FOUND") {
      throw new ApiError(404, "ROOM_NOT_FOUND", "Room not found.");
    }
    throw error;
  }
});

/**
 * DELETE /api/admin/settings/rooms?roomId= — remove an unused active-event room.
 *
 * A Room owns its ScheduleSlots with `onDelete: Cascade`. Locking and re-reading
 * the scoped Room before checking slot use keeps that cascade unreachable: a
 * concurrent slot insert's FK key-share lock waits for this transaction, then
 * can only proceed after this transaction has either refused or deleted the row.
 */
export const DELETE = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const roomId = new URL(req.url).searchParams.get("roomId");
  if (!roomId) throw new ApiError(400, "MISSING_ROOM", "roomId is required.");

  const room = await prisma.$transaction(async (tx) => {
    // Scope is part of the locked query: cross-event and unknown IDs produce
    // the same result and never reveal whether another event owns the row.
    const [lockedRoom] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id"
      FROM "Room"
      WHERE "id" = ${roomId} AND "eventId" = ${ctx.eventId}
      FOR UPDATE
    `;
    if (!lockedRoom) throw new ApiError(404, "ROOM_NOT_FOUND", "Room not found.");

    const scheduleSlot = await tx.scheduleSlot.findFirst({
      where: { roomId: lockedRoom.id },
      select: { id: true },
    });
    const decision = decideRoomDeletion(!!scheduleSlot);
    if (!decision.allowed) {
      throw new ApiError(409, decision.code, decision.message, {
        roomId: ["Move or unschedule the room's sessions before removing it."],
      });
    }

    return tx.room.delete({ where: { id: lockedRoom.id }, select: roomSelect });
  });

  return ok({ room });
});
