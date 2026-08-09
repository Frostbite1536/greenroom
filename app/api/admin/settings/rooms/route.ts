import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { roomCreateSchema, roomUpdateSchema } from "@/types/api";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";

export const dynamic = "force-dynamic";

const roomOrder = [{ sortOrder: "asc" as const }, { name: "asc" as const }, { id: "asc" as const }];
const roomSelect = { id: true, name: true, capacity: true, sortOrder: true } as const;

function roomNameTaken(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** GET /api/admin/settings/rooms — active-event rooms, stable for settings UI. */
export const GET = handle(async () => {
  const ctx = await requireContext(["ADMIN"]);
  const rooms = await prisma.room.findMany({
    where: { eventId: ctx.eventId },
    orderBy: roomOrder,
    select: roomSelect,
  });
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
    if (roomNameTaken(error)) {
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
    if (roomNameTaken(error)) {
      throw new ApiError(409, "ROOM_NAME_TAKEN", "Another room in this event already uses that name.", {
        name: ["This room name is already in use."],
      });
    }
    throw error;
  }
});
