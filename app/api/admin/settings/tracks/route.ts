import { prisma } from "@/lib/prisma";
import { trackCreateSchema, trackUpdateSchema } from "@/types/api";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { assertEventQueryBound, OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import { decideTrackDeletion } from "@/lib/services/track-deletion";
import { requireEventOwnedRow } from "@/lib/services/event-owned-row";
import { classifyTrackMutationError } from "@/lib/services/track-mutation-errors";

export const dynamic = "force-dynamic";

const trackOrder = [{ sortOrder: "asc" as const }, { name: "asc" as const }, { id: "asc" as const }];
const trackSelect = { id: true, name: true, color: true, sortOrder: true } as const;

/** GET /api/admin/settings/tracks — active-event tracks, stable for settings UI. */
export const GET = handle(async () => {
  const ctx = await requireContext(["ADMIN"]);
  const tracks = await prisma.track.findMany({
    where: { eventId: ctx.eventId },
    orderBy: trackOrder,
    take: OPERATOR_QUERY_LIMITS.settingsTracks + 1,
    select: trackSelect,
  });
  assertEventQueryBound(tracks, OPERATOR_QUERY_LIMITS.settingsTracks, "tracks in event settings");
  return ok({ tracks });
});

/** POST /api/admin/settings/tracks — add a track to the active event. */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, trackCreateSchema);
  try {
    const track = await prisma.track.create({
      data: {
        eventId: ctx.eventId,
        name: input.name,
        color: input.color,
        sortOrder: input.sortOrder ?? 0,
      },
      select: trackSelect,
    });
    return ok({ track }, 201);
  } catch (error) {
    if (classifyTrackMutationError(error) === "TRACK_NAME_TAKEN") {
      throw new ApiError(409, "TRACK_NAME_TAKEN", "Another track in this event already uses that name.", {
        name: ["This track name is already in use."],
      });
    }
    throw error;
  }
});

/** PATCH /api/admin/settings/tracks — update a track only after active-event scope check. */
export const PATCH = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, trackUpdateSchema);

  try {
    const track = await prisma.$transaction(async (tx) => {
      // Read the stored event under the same exclusive lock as the write. A
      // caller-controlled track id can never authorize a cross-event update.
      const [existing] = await tx.$queryRaw<{ id: string; eventId: string }[]>`
        SELECT "id", "eventId" FROM "Track" WHERE "id" = ${input.id} FOR UPDATE
      `;
      const owned = requireEventOwnedRow(existing, ctx.eventId, "TRACK_NOT_FOUND", "Track");
      return tx.track.update({
        where: { id: owned.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.color !== undefined ? { color: input.color } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        },
        select: trackSelect,
      });
    });
    return ok({ track });
  } catch (error) {
    const mutationError = classifyTrackMutationError(error);
    if (mutationError === "TRACK_NAME_TAKEN") {
      throw new ApiError(409, "TRACK_NAME_TAKEN", "Another track in this event already uses that name.", {
        name: ["This track name is already in use."],
      });
    }
    // The scoped preflight may be invalidated by a concurrent delete. Keep
    // that race indistinguishable from an unknown or cross-event track ID.
    if (mutationError === "TRACK_NOT_FOUND") {
      throw new ApiError(404, "TRACK_NOT_FOUND", "Track not found.");
    }
    throw error;
  }
});

/**
 * DELETE /api/admin/settings/tracks?trackId= — remove an unscheduled track.
 *
 * A Track's `ScheduleSlot` rows point at it with `onDelete: SetNull`, so the
 * danger here is silence rather than cascade: deleting a used track would strip
 * the swimlane off every session on it without naming one. Locking and
 * re-reading the scoped Track before checking slot use keeps that unreachable —
 * a concurrent slot insert's FK key-share lock waits for this transaction, then
 * can only proceed after this transaction has either refused or deleted the
 * row. `decideTrackDeletion` owns the refusal so the policy stays testable.
 */
export const DELETE = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const trackId = new URL(req.url).searchParams.get("trackId");
  if (!trackId) throw new ApiError(400, "MISSING_TRACK", "trackId is required.");

  const track = await prisma.$transaction(async (tx) => {
    // Scope is part of the locked query: cross-event and unknown IDs produce
    // the same result and never reveal whether another event owns the row.
    const [lockedTrack] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id"
      FROM "Track"
      WHERE "id" = ${trackId} AND "eventId" = ${ctx.eventId}
      FOR UPDATE
    `;
    if (!lockedTrack) throw new ApiError(404, "TRACK_NOT_FOUND", "Track not found.");

    const scheduleSlot = await tx.scheduleSlot.findFirst({
      where: { trackId: lockedTrack.id },
      select: { id: true },
    });
    const decision = decideTrackDeletion(!!scheduleSlot);
    if (!decision.allowed) {
      throw new ApiError(409, decision.code, decision.message, {
        trackId: ["Move the track's sessions to another track before removing it."],
      });
    }

    return tx.track.delete({ where: { id: lockedTrack.id }, select: trackSelect });
  });

  return ok({ track });
});
