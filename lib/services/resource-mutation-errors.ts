import { Prisma } from "@prisma/client";

export type ResourceMutationError = "RESOURCE_SLUG_TAKEN" | "RESOURCE_NOT_FOUND";

/**
 * Classify only known Prisma resource-write races; everything else must surface.
 *
 * `ResourceWiki` carries `@@unique([eventId, slug])`, so two organizers racing
 * on the same portal address is a P2002 that must reach the caller as a named
 * refusal rather than a 500 they cannot act on. P2025 is the concurrent delete
 * that can invalidate a scoped preflight, and is deliberately reported as the
 * same not-found a cross-event id gets.
 *
 * Lives beside the route rather than inside `resource-wiki.ts` because that
 * module is imported by the authoring client component, and pulling `@prisma/client`
 * into a `"use client"` graph is not something a helper should do quietly.
 */
export function classifyResourceMutationError(error: unknown): ResourceMutationError | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  if (error.code === "P2002") return "RESOURCE_SLUG_TAKEN";
  if (error.code === "P2025") return "RESOURCE_NOT_FOUND";
  return null;
}
