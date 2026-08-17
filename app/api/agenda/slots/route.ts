import { prisma } from "@/lib/prisma";
import { scheduleSlotInputSchema } from "@/types/api";
import { assertEventScope, requireContext } from "@/lib/api/context";
import { ApiError, fail, handle, ok, parseBody } from "@/lib/api/http";
import {
  AUDITED_SCHEDULE_SLOT_FIELDS,
  diffChanges,
  recordAudit,
} from "@/lib/services/audit-log";
import { detectConflicts, type SlotInterval } from "@/lib/services/schedule";
import { lockScheduleWrite } from "@/lib/services/schedule-lock";
import { resolveCandidateSlotId, unscheduleSessionSlot } from "@/lib/services/schedule-slot-write";
import { describeScheduleConflict } from "@/lib/services/schedule-conflict-copy";

export const dynamic = "force-dynamic";

/**
 * POST /api/agenda/slots — place (or move) a session on the schedule (admin).
 * Detection and write happen in one transaction (INV-SCHEDULE-001): if a room
 * or speaker overlap is found the write is refused and the conflicts are
 * returned so the UI can explain the collision. Pass `?force=true` to override
 * (records the placement anyway) — used sparingly for the seeded demo conflict.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const force = new URL(req.url).searchParams.get("force") === "true";
  const input = await parseBody(req, scheduleSlotInputSchema);
  assertEventScope(ctx, input.eventId);

  const result = await prisma.$transaction(async (tx) => {
    // S3 / LOCK-ORDER-v1: the event-wide schedule predicate key, taken first and
    // shared with bulk auto-placement. `FOR UPDATE` cannot lock a row that does
    // not exist yet, so without this key a concurrent placement could insert the
    // very slot that invalidates the conflict check below. Nothing else about
    // this route's behaviour, responses, or lock classes changes.
    await lockScheduleWrite(tx, ctx.eventId);

    const session = await tx.session.findUnique({
      where: { id: input.sessionId },
      include: { speakers: { select: { userId: true } } },
    });
    if (!session || session.eventId !== ctx.eventId) {
      throw new ApiError(404, "SESSION_NOT_FOUND", "Session not found.");
    }

    const room = await tx.room.findUnique({ where: { id: input.roomId } });
    if (!room || room.eventId !== ctx.eventId) {
      throw new ApiError(404, "ROOM_NOT_FOUND", "Room not found.");
    }
    if (input.trackId) {
      const track = await tx.track.findUnique({ where: { id: input.trackId } });
      if (!track || track.eventId !== ctx.eventId) {
        throw new ApiError(404, "TRACK_NOT_FOUND", "Track not found.");
      }
    }

    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    const speakerIds = session.speakers.map((s) => s.userId);

    const existingSlots = await tx.scheduleSlot.findMany({
      where: { eventId: ctx.eventId },
      include: { session: { include: { speakers: { select: { userId: true } } } } },
    });
    const intervals: SlotInterval[] = existingSlots.map((slot) => ({
      slotId: slot.id,
      roomId: slot.roomId,
      startsAt: slot.startsAt.getTime(),
      endsAt: slot.endsAt.getTime(),
      speakerIds: slot.session.speakers.map((s) => s.userId),
    }));

    // A session has at most one slot (unique sessionId): treat that as the
    // candidate identity so moving a session doesn't conflict with itself. The
    // server's own slot is the only admissible identity — a request naming any
    // other one is refused rather than allowed to exclude that slot from the
    // check below (see `resolveCandidateSlotId`).
    const ownSlot = existingSlots.find((s) => s.sessionId === input.sessionId);
    const conflicts = detectConflicts(
      {
        slotId: resolveCandidateSlotId(input.id, ownSlot?.id),
        roomId: input.roomId,
        startsAt: startsAt.getTime(),
        endsAt: endsAt.getTime(),
        speakerIds,
      },
      intervals,
    );

    if (conflicts.length > 0 && !force) {
      // Only the refusal branch pays for the names. Widening the `existingSlots`
      // read above would have added a room + speaker join to every successful
      // placement to serve a message nobody reads; this second read is scoped to
      // the handful of slots actually collided with, and still runs inside the
      // same transaction and the same S3 lock, so what the refusal names is the
      // state the refusal was decided against.
      const conflictingSlotIds = [...new Set(conflicts.map((c) => c.conflictingSlotId))];
      const [event, named] = await Promise.all([
        tx.event.findUnique({ where: { id: ctx.eventId }, select: { timezone: true } }),
        tx.scheduleSlot.findMany({
          where: { id: { in: conflictingSlotIds } },
          select: {
            id: true,
            startsAt: true,
            endsAt: true,
            room: { select: { name: true } },
            session: {
              select: {
                title: true,
                speakers: { select: { userId: true, user: { select: { name: true } } } },
              },
            },
          },
        }),
      ]);
      const timeZone = event?.timezone ?? "UTC";
      const bySlotId = new Map(named.map((slot) => [slot.id, slot]));

      const conflictDetails = conflicts.flatMap((conflict) => {
        const slot = bySlotId.get(conflict.conflictingSlotId);
        // A slot that vanished between detection and this read has nothing
        // truthful to say, so it is dropped rather than described from guesses
        // — `conflicts` below still reports it.
        if (!slot) return [];
        return [
          describeScheduleConflict({
            type: conflict.type,
            roomName: slot.room.name,
            sessionTitle: slot.session.title,
            startsAt: slot.startsAt.toISOString(),
            endsAt: slot.endsAt.toISOString(),
            speakerName:
              slot.session.speakers.find((s) => s.userId === conflict.speakerId)?.user.name ?? null,
            timeZone,
          }),
        ];
      });

      return { slot: null, conflicts, conflictDetails };
    }

    const slot = await tx.scheduleSlot.upsert({
      where: { sessionId: input.sessionId },
      update: {
        roomId: input.roomId,
        trackId: input.trackId ?? null,
        startsAt,
        endsAt,
      },
      create: {
        eventId: ctx.eventId,
        sessionId: input.sessionId,
        roomId: input.roomId,
        trackId: input.trackId ?? null,
        startsAt,
        endsAt,
      },
    });

    // W24 / INV-AUDIT-001: the placement's history commits with the placement,
    // inside the same S3 lock that decided it. First placement and move are named
    // separately from `ownSlot` — the same read the conflict check already used,
    // so this adds no query — and the diff is taken against the slot's own stored
    // values, so re-placing a talk where it already sits records nothing.
    //
    // The history is keyed on the SESSION id, not the slot id: unscheduling
    // deletes the slot row and re-placing creates a new one, and one talk's
    // placement history must not scatter across identities nothing joins.
    await recordAudit(tx, {
      eventId: ctx.eventId,
      actorUserId: ctx.userId,
      entityType: "SCHEDULE_SLOT",
      entityId: slot.sessionId,
      action: ownSlot ? "MOVE" : "SCHEDULE",
      changes: diffChanges(
        {
          roomId: ownSlot?.roomId,
          trackId: ownSlot?.trackId,
          startsAt: ownSlot?.startsAt,
          endsAt: ownSlot?.endsAt,
        },
        { roomId: slot.roomId, trackId: slot.trackId, startsAt: slot.startsAt, endsAt: slot.endsAt },
        AUDITED_SCHEDULE_SLOT_FIELDS,
      ),
    });

    return { slot, conflicts, conflictDetails: [] as string[] };
  });

  if (!result.slot) {
    return fail(409, "SCHEDULE_CONFLICT", "This placement conflicts with an existing slot.", {
      // `conflicts` is unchanged, byte for byte: existing consumers (and the
      // smoke that pins this shape) keep reading exactly what they read before.
      conflicts: result.conflicts.map((c) => `${c.type}: ${c.message}`),
      // Additive: the same collisions with the room, talk, time and speaker
      // named. Empty only when nothing could be resolved, so a client that
      // prefers it must still fall back to `conflicts`.
      ...(result.conflictDetails.length > 0 ? { conflictDetails: result.conflictDetails } : {}),
    });
  }

  return ok({
    slot: {
      id: result.slot.id,
      sessionId: result.slot.sessionId,
      roomId: result.slot.roomId,
      trackId: result.slot.trackId,
      startsAt: result.slot.startsAt.toISOString(),
      endsAt: result.slot.endsAt.toISOString(),
    },
    conflicts: result.conflicts,
  });
});

/**
 * DELETE /api/agenda/slots?sessionId= — unschedule a session (admin).
 *
 * Removing a slot changes the same event-wide conflict predicate a placement is
 * checked against, so it runs in one transaction and takes the S3 event lock
 * first — the same key, in the same position, as POST above and bulk
 * auto-placement apply. Responses are unchanged.
 *
 * The removal's history row is appended by `unscheduleSessionSlot` itself, under
 * that same lock (W24, INV-AUDIT-001), which is why the actor id is passed in:
 * the service owns the whole locked write, so it owns the record of it too.
 */
export const DELETE = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const sessionId = new URL(req.url).searchParams.get("sessionId");
  if (!sessionId) throw new ApiError(400, "MISSING_SESSION", "sessionId is required.");

  const result = await prisma.$transaction((tx) =>
    unscheduleSessionSlot(tx, { eventId: ctx.eventId, sessionId, actorUserId: ctx.userId }),
  );
  return ok(result);
});
