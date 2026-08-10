import { prisma } from "@/lib/prisma";
import { assertEventScope, requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { assertEventQueryBound, OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import { zonedParts } from "@/lib/tz";
import { detectConflicts, type SlotInterval } from "@/lib/services/schedule";
import {
  placementDayKeys,
  placementSnapshotFingerprint,
  PLACEMENT_STEP_MINUTES,
  PLACEMENT_WINDOW_END_MINUTE,
  PLACEMENT_WINDOW_START_MINUTE,
  type PlacementSnapshot,
} from "@/lib/services/agenda-autoplace";
import {
  openSlotApplyInputSchema,
  OPEN_SLOT_STALE_CODE,
  STALE_PREVIEW_MESSAGE,
} from "@/lib/services/agenda-autoplace-request";
import {
  lockEventScheduleSlotsForUpdate,
  lockScheduleRoomsForShare,
  lockScheduleSessionsForShare,
  lockScheduleSpeakersForShare,
  lockScheduleWrite,
} from "@/lib/services/schedule-lock";

export const dynamic = "force-dynamic";

/**
 * POST /api/agenda/autoplace/apply — commit a reviewed placement plan (admin,
 * AIA-08, addendum §4.2).
 *
 * The client's copy of the preview is treated as a *request*, never as a
 * finding. Between preview and apply another administrator can move a session,
 * delete a room, or change a speaker assignment, so this route establishes the
 * authoritative transactional snapshot (S3 under `LOCK-ORDER-v1`), re-reads
 * sessions, speakers, rooms, event dates and existing slots, and revalidates
 * every target and every conflict from scratch. The fingerprint is checked too,
 * but only as a cheap early exit — it never replaces the fresh validation
 * below, and removing it would not weaken any refusal.
 *
 * All or nothing: every refusal throws, which rolls the transaction back before
 * a single slot is written. There is no path here that commits part of a plan.
 *
 * Side effects (§4.3): none beyond the `ScheduleSlot` rows. No calendar message
 * is enqueued and no revision counter is touched — placement is the whole
 * scope, and the limitation is stated rather than half-implemented.
 * `contentStatus` is likewise never written: placing a talk does not publish
 * it, so this cannot bypass the publication gate.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, openSlotApplyInputSchema);
  assertEventScope(ctx, input.eventId);

  /**
   * One refusal for every rejected class — stale, unknown, cross-event,
   * out-of-window, conflicting. The reason code is non-identifying: an ID that
   * belongs to another event is refused exactly like an ID that never existed,
   * so this cannot be used to probe another event's data.
   */
  const refuse = (reason: string): never => {
    throw new ApiError(409, OPEN_SLOT_STALE_CODE, STALE_PREVIEW_MESSAGE, { placements: [reason] });
  };

  const applied = await prisma.$transaction(async (tx) => {
    const event = await tx.event.findUnique({
      where: { id: ctx.eventId },
      select: { timezone: true, startsAt: true, endsAt: true },
    });
    if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found.");
    const timezone = event.timezone;

    const targetSessionIds = input.placements.map((placement) => placement.sessionId);
    const targetRoomIds = input.placements.map((placement) => placement.roomId);
    const proposedDayKeys = input.placements.map(
      (placement) => zonedParts(placement.startsAt, timezone).dateKey,
    );

    // Which sessions already hold a slot, read before any lock purely to know
    // whose speaker rows must be locked: a conflict can involve a speaker on a
    // session this plan never mentions. The set is re-derived under the slot
    // lock below and any growth is refused, so an unlocked read here cannot
    // widen what this transaction accepts.
    const preLockSlotSessionIds = (
      await tx.scheduleSlot.findMany({ where: { eventId: ctx.eventId }, select: { sessionId: true } })
    ).map((slot) => slot.sessionId);

    // --- S3 / LOCK-ORDER-v1, in order ---
    await lockScheduleWrite(tx, ctx.eventId, proposedDayKeys);
    const lockedRooms = await lockScheduleRoomsForShare(tx, ctx.eventId, targetRoomIds);
    const lockedSpeakers = await lockScheduleSpeakersForShare(
      tx,
      [...targetSessionIds, ...preLockSlotSessionIds],
    );
    const lockedSessions = await lockScheduleSessionsForShare(
      tx,
      [...targetSessionIds, ...preLockSlotSessionIds],
    );
    const lockedSlots = await lockEventScheduleSlotsForUpdate(tx, ctx.eventId);

    const speakersBySession = new Map<string, string[]>();
    for (const row of lockedSpeakers) {
      const existing = speakersBySession.get(row.sessionId);
      if (existing) existing.push(row.userId);
      else speakersBySession.set(row.sessionId, [row.userId]);
    }
    const speakersOf = (sessionId: string) => speakersBySession.get(sessionId) ?? [];

    // A slot that appeared after the pre-lock read belongs to a session whose
    // speakers this transaction does not hold, so its conflicts cannot be
    // checked honestly. Refuse rather than check against a set that may move.
    const lockedSessionIds = new Set(lockedSessions.map((session) => session.id));
    if (lockedSlots.some((slot) => !lockedSessionIds.has(slot.sessionId))) {
      refuse("SCHEDULE_CHANGED");
    }

    // --- fresh reads under the locks ---
    const [rooms, sessions] = await Promise.all([
      tx.room.findMany({
        where: { eventId: ctx.eventId },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        select: { id: true, sortOrder: true },
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
          scheduleSlot: { select: { id: true, roomId: true, startsAt: true, endsAt: true } },
        },
      }),
    ]);
    assertEventQueryBound(rooms, OPERATOR_QUERY_LIMITS.settingsRooms, "rooms");
    assertEventQueryBound(sessions, OPERATOR_QUERY_LIMITS.agendaSessions, "sessions");

    // Built exactly as the preview builds it, so the fingerprints are
    // comparable at all.
    const snapshot: PlacementSnapshot = {
      eventId: ctx.eventId,
      timezone,
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
      eventDayKeys: placementDayKeys(event.startsAt, event.endsAt, timezone),
    };
    if (placementSnapshotFingerprint(snapshot) !== input.fingerprint) refuse("SNAPSHOT_CHANGED");

    // --- per-target revalidation against the locked rows ---
    const roomIds = new Set(lockedRooms.map((room) => room.id));
    const sessionById = new Map(lockedSessions.map((session) => [session.id, session]));
    const scheduledSessionIds = new Set(lockedSlots.map((slot) => slot.sessionId));
    const searchableDays = new Set(snapshot.eventDayKeys ?? []);
    for (const slot of lockedSlots) {
      searchableDays.add(zonedParts(slot.startsAt.toISOString(), timezone).dateKey);
    }

    // Existing placements first; each accepted proposal joins the set, so the
    // plan is checked against itself as well as against the schedule.
    const intervals: SlotInterval[] = lockedSlots.map((slot) => ({
      slotId: slot.id,
      roomId: slot.roomId,
      startsAt: slot.startsAt.getTime(),
      endsAt: slot.endsAt.getTime(),
      speakerIds: speakersOf(slot.sessionId),
    }));

    const rows = input.placements.map((placement) => {
      const session = sessionById.get(placement.sessionId);
      // Unknown and cross-event are the same refusal, deliberately.
      if (!session || session.eventId !== ctx.eventId) refuse("SESSION_NOT_FOUND");
      if (scheduledSessionIds.has(placement.sessionId)) refuse("ALREADY_SCHEDULED");
      if (!roomIds.has(placement.roomId)) refuse("ROOM_NOT_FOUND");

      const startsAt = new Date(placement.startsAt);
      const endsAt = new Date(placement.endsAt);
      const durationMinutes = (endsAt.getTime() - startsAt.getTime()) / 60_000;
      // The talk's stored length is the authority, not the client's arithmetic.
      if (durationMinutes !== session!.durationMinutes) refuse("DURATION_CHANGED");

      const local = zonedParts(placement.startsAt, timezone);
      if (!searchableDays.has(local.dateKey)) refuse("OUT_OF_WINDOW");
      if (local.minutesOfDay < PLACEMENT_WINDOW_START_MINUTE) refuse("OUT_OF_WINDOW");
      if (local.minutesOfDay % PLACEMENT_STEP_MINUTES !== 0) refuse("OUT_OF_WINDOW");
      if (local.minutesOfDay + durationMinutes > PLACEMENT_WINDOW_END_MINUTE) refuse("OUT_OF_WINDOW");

      const candidate = {
        roomId: placement.roomId,
        startsAt: startsAt.getTime(),
        endsAt: endsAt.getTime(),
        speakerIds: speakersOf(placement.sessionId),
      };
      if (detectConflicts(candidate, intervals).length > 0) refuse("CONFLICT");
      intervals.push({ slotId: `applying:${placement.sessionId}`, ...candidate });

      return {
        eventId: ctx.eventId,
        sessionId: placement.sessionId,
        roomId: placement.roomId,
        trackId: null,
        startsAt,
        endsAt,
      };
    });

    // One statement, inside the transaction that holds every lock above: the
    // whole plan lands or none of it does.
    await tx.scheduleSlot.createMany({ data: rows });
    return rows.map((row) => ({
      sessionId: row.sessionId,
      roomId: row.roomId,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
    }));
  });

  return ok({ applied: applied.length, placements: applied });
});
