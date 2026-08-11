import { Prisma } from "@prisma/client";

export type TrackMutationError = "TRACK_NAME_TAKEN" | "TRACK_NOT_FOUND";

/** Classify only known Prisma track-write races; everything else must surface. */
export function classifyTrackMutationError(error: unknown): TrackMutationError | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  if (error.code === "P2002") return "TRACK_NAME_TAKEN";
  if (error.code === "P2025") return "TRACK_NOT_FOUND";
  return null;
}
