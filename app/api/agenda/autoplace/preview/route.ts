import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { assertEventScope, requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { assertEventQueryBound, OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import {
  placementDayKeys,
  placementSnapshotFingerprint,
  planOpenSlotPlacements,
  type PlacementSnapshot,
} from "@/lib/services/agenda-autoplace";
import { openSlotPreviewInputSchema } from "@/lib/services/agenda-autoplace-request";

export const dynamic = "force-dynamic";

/**
 * POST /api/agenda/autoplace/preview — propose placements for the unscheduled
 * backlog (admin, AIA-08, addendum §4.1).
 *
 * Writes nothing. Not a slot, not a revision counter, not a queued message —
 * this route only reads and returns a plan the operator can accept or discard.
 * It takes no schedule locks for the same reason: a read that changes nothing
 * has nothing to protect, and holding the event's schedule locks for the length
 * of an operator's review would be worse than useless.
 *
 * The plan is therefore advisory by construction. `POST .../apply` re-reads
 * everything under the locks and revalidates every target before it writes;
 * this response, including its fingerprint, is never trusted as authority.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, openSlotPreviewInputSchema);
  assertEventScope(ctx, input.eventId);

  // One RepeatableRead snapshot: a fingerprint computed from reads that saw
  // different moments would describe a schedule that never existed.
  const snapshotRows = await prisma.$transaction(
    async (tx) => {
      const event = await tx.event.findUnique({
        where: { id: ctx.eventId },
        select: { timezone: true, startsAt: true, endsAt: true },
      });
      if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found.");

      const [rooms, sessions] = await Promise.all([
        tx.room.findMany({
          where: { eventId: ctx.eventId },
          orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
          select: { id: true, name: true, sortOrder: true },
          take: OPERATOR_QUERY_LIMITS.settingsRooms + 1,
        }),
        tx.session.findMany({
          where: { eventId: ctx.eventId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: OPERATOR_QUERY_LIMITS.agendaSessions + 1,
          select: {
            id: true,
            title: true,
            durationMinutes: true,
            speakers: { select: { userId: true } },
            scheduleSlot: {
              select: { id: true, roomId: true, startsAt: true, endsAt: true },
            },
          },
        }),
      ]);
      return { event, rooms, sessions };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );

  const { event, rooms, sessions } = snapshotRows;
  assertEventQueryBound(rooms, OPERATOR_QUERY_LIMITS.settingsRooms, "rooms");
  // Fail closed rather than plan against a partial programme: a conflict in the
  // sessions this read never loaded is one nothing here could have avoided.
  assertEventQueryBound(sessions, OPERATOR_QUERY_LIMITS.agendaSessions, "sessions");

  const snapshot: PlacementSnapshot = {
    eventId: ctx.eventId,
    timezone: event.timezone,
    rooms: rooms.map((room) => ({ id: room.id, sortOrder: room.sortOrder })),
    existingSlots: sessions.flatMap((session) =>
      session.scheduleSlot
        ? [{
            slotId: session.scheduleSlot.id,
            sessionId: session.id,
            roomId: session.scheduleSlot.roomId,
            startsAt: session.scheduleSlot.startsAt.getTime(),
            endsAt: session.scheduleSlot.endsAt.getTime(),
            speakerIds: session.speakers.map((speaker) => speaker.userId),
          }]
        : [],
    ),
    unscheduled: sessions.flatMap((session) =>
      session.scheduleSlot
        ? []
        : [{
            id: session.id,
            title: session.title,
            durationMinutes: session.durationMinutes,
            speakerIds: session.speakers.map((speaker) => speaker.userId),
          }],
    ),
    eventDayKeys: placementDayKeys(event.startsAt, event.endsAt, event.timezone),
  };

  const plan = planOpenSlotPlacements(snapshot);

  return ok({
    fingerprint: placementSnapshotFingerprint(snapshot),
    timezone: event.timezone,
    days: plan.days,
    window: plan.window,
    /** How many sessions were considered at all, so an empty plan is legible. */
    consideredSessions: snapshot.unscheduled.length,
    placements: plan.placements,
    unplaceable: plan.unplaceable,
  });
});
