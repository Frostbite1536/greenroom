import { z } from "zod";
import { idSchema } from "@/types/api";

/**
 * Request contracts for the "Fill open slots" preview and apply routes.
 *
 * Backend-owned rather than added to the shared `types/api.ts` surface: this is
 * one lane's route pair, and the shared contract file is architect-owned. The
 * routes still return the locked `ApiResponse<T>` envelope.
 *
 * The refusals encoded here are the ones that can be decided from the request
 * body alone. Everything that depends on state — ownership, eligibility, room
 * existence, the placement window, conflicts — is decided server-side under the
 * schedule locks against freshly re-read rows, never here and never from the
 * client's copy of the preview.
 */

/**
 * A plan larger than this is not a plan an operator reviewed. It is also the
 * bound on the work one apply transaction holds the event's schedule locks for.
 */
export const OPEN_SLOT_PLAN_MAX_PLACEMENTS = 500;

/**
 * The refusal message for every stale, unknown, out-of-window, or conflicting
 * target (addendum §4.2). One message for every class on purpose: it is the
 * truthful next step in all of them, and it cannot be used to probe whether an
 * ID that is not the caller's exists.
 */
export const STALE_PREVIEW_MESSAGE =
  "The agenda changed after this preview was created. Generate a new preview before applying it.";

export const OPEN_SLOT_STALE_CODE = "STALE_PREVIEW";

export const openSlotPreviewInputSchema = z.object({
  eventId: idSchema,
});

export const openSlotPlacementSchema = z
  .object({
    sessionId: idSchema,
    roomId: idSchema,
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
  })
  .refine((placement) => new Date(placement.startsAt) < new Date(placement.endsAt), {
    message: "endsAt must be after startsAt",
    path: ["endsAt"],
  });

export const openSlotApplyInputSchema = z
  .object({
    eventId: idSchema,
    /** From the preview. An aid to stale detection, never an authority. */
    fingerprint: z.string().min(1).max(128),
    placements: z.array(openSlotPlacementSchema).min(1).max(OPEN_SLOT_PLAN_MAX_PLACEMENTS),
  })
  .superRefine((input, ctx) => {
    // A session has at most one slot. Two proposals for the same session are a
    // malformed plan, not a race, so they are refused before any lock is taken.
    const seen = new Set<string>();
    for (const [position, placement] of input.placements.entries()) {
      if (seen.has(placement.sessionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["placements", position, "sessionId"],
          message: "This plan proposes the same session more than once.",
        });
        return;
      }
      seen.add(placement.sessionId);
    }
  });

export type OpenSlotApplyInput = z.infer<typeof openSlotApplyInputSchema>;
export type OpenSlotPlacementInput = z.infer<typeof openSlotPlacementSchema>;
