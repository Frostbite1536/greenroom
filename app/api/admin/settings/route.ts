import { prisma } from "@/lib/prisma";
import { eventSettingsUpdateSchema } from "@/types/api";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
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
      select: { id: true, name: true, capacity: true, sortOrder: true },
    }),
    prisma.track.findMany({
      where: { eventId: ctx.eventId },
      orderBy: settingsOrder,
      select: { id: true, name: true, color: true, sortOrder: true },
    }),
    prisma.category.findMany({
      where: { eventId: ctx.eventId },
      orderBy: settingsOrder,
      select: { id: true, name: true, description: true, defaultTeamKey: true, sortOrder: true },
    }),
  ]);
  if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found.");

  return ok({ event: serializeSettingsEvent(event), rooms, tracks, categories });
});

/** PATCH /api/admin/settings — update only identity, local dates, and timezone. */
export const PATCH = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const patch = await parseBody(req, eventSettingsUpdateSchema);
  const event = await prisma.event.findUnique({
    where: { id: ctx.eventId },
    select: { id: true, name: true, slug: true, timezone: true, startsAt: true, endsAt: true },
  });
  if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found.");

  const updated = await prisma.event.update({
    where: { id: ctx.eventId },
    data: planEventSettingsUpdate(event, patch),
    select: { id: true, name: true, slug: true, timezone: true, startsAt: true, endsAt: true },
  });
  return ok({ event: serializeSettingsEvent(updated) });
});
