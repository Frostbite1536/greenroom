import { prisma } from "@/lib/prisma";
import { eventSettingsUpdateSchema } from "@/types/api";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { assertEventQueryBound, OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import { planEventSettingsUpdate, serializeSettingsEvent } from "@/lib/services/event-settings";

export const dynamic = "force-dynamic";

const settingsOrder = [{ sortOrder: "asc" as const }, { name: "asc" as const }, { id: "asc" as const }];

/** GET /api/admin/settings — the active event's read-mostly configuration. */
export const GET = handle(async () => {
  const ctx = await requireContext(["ADMIN"]);
  const [event, rooms, tracks, categories] = await Promise.all([
    prisma.event.findUnique({
      where: { id: ctx.eventId },
      select: { id: true, name: true, slug: true, timezone: true, startsAt: true, endsAt: true },
    }),
    prisma.room.findMany({
      where: { eventId: ctx.eventId },
      orderBy: settingsOrder,
      take: OPERATOR_QUERY_LIMITS.settingsRooms + 1,
      select: { id: true, name: true, capacity: true, sortOrder: true },
    }),
    prisma.track.findMany({
      where: { eventId: ctx.eventId },
      orderBy: settingsOrder,
      take: OPERATOR_QUERY_LIMITS.settingsTracks + 1,
      select: { id: true, name: true, color: true, sortOrder: true },
    }),
    prisma.category.findMany({
      where: { eventId: ctx.eventId },
      orderBy: settingsOrder,
      take: OPERATOR_QUERY_LIMITS.settingsCategories + 1,
      select: { id: true, name: true, description: true, defaultTeamKey: true, sortOrder: true },
    }),
  ]);
  if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found.");
  assertEventQueryBound(rooms, OPERATOR_QUERY_LIMITS.settingsRooms, "rooms in event settings");
  assertEventQueryBound(tracks, OPERATOR_QUERY_LIMITS.settingsTracks, "tracks in event settings");
  assertEventQueryBound(categories, OPERATOR_QUERY_LIMITS.settingsCategories, "categories in event settings");

  return ok({ event: serializeSettingsEvent(event), rooms, tracks, categories });
});

/** PATCH /api/admin/settings — update only identity, local dates, and timezone. */
export const PATCH = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const patch = await parseBody(req, eventSettingsUpdateSchema);
  const updated = await prisma.$transaction(async (tx) => {
    // Acquire the row lock before the read/plan/write sequence. A settings
    // PATCH must use current values to preserve event-local date semantics and
    // must not expand omitted fields from a stale pre-transaction snapshot.
    const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id"
      FROM "Event"
      WHERE "id" = ${ctx.eventId}
      FOR UPDATE
    `;
    if (!locked) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found.");

    const event = await tx.event.findUniqueOrThrow({
      where: { id: locked.id },
      select: { id: true, name: true, slug: true, timezone: true, startsAt: true, endsAt: true },
    });
    return tx.event.update({
      where: { id: event.id },
      data: planEventSettingsUpdate(event, patch),
      select: { id: true, name: true, slug: true, timezone: true, startsAt: true, endsAt: true },
    });
  });
  return ok({ event: serializeSettingsEvent(updated) });
});
