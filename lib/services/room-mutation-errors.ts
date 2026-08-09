import { Prisma } from "@prisma/client";

export type RoomMutationError = "ROOM_NAME_TAKEN" | "ROOM_NOT_FOUND";

/** Classify only known Prisma room-write races; everything else must surface. */
export function classifyRoomMutationError(error: unknown): RoomMutationError | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  if (error.code === "P2002") return "ROOM_NAME_TAKEN";
  if (error.code === "P2025") return "ROOM_NOT_FOUND";
  return null;
}
