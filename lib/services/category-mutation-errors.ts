import { Prisma } from "@prisma/client";

export type CategoryMutationError = "CATEGORY_NAME_TAKEN" | "CATEGORY_NOT_FOUND";

/**
 * Classify only known Prisma category-write races; everything else must
 * surface. `P2002` is `Category`'s `@@unique([eventId, name])`; `P2025` is the
 * scoped preflight being invalidated by a concurrent delete, which must stay
 * indistinguishable from an unknown or cross-event id.
 */
export function classifyCategoryMutationError(error: unknown): CategoryMutationError | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  if (error.code === "P2002") return "CATEGORY_NAME_TAKEN";
  if (error.code === "P2025") return "CATEGORY_NOT_FOUND";
  return null;
}
