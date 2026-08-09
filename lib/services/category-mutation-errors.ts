import { Prisma } from "@prisma/client";

/** Expected uniqueness failure for Category's `@@unique([eventId, name])`. */
export function classifyCategoryMutationError(error: unknown): "CATEGORY_NAME_TAKEN" | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return "CATEGORY_NAME_TAKEN";
  }
  return null;
}
