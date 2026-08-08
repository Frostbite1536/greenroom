import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildIcsCalendar, icsFilename, type IcsEvent } from "@/lib/calendar/ics";
import type { ApiResponse } from "@/types/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(code: string, message: string, status: number) {
  return NextResponse.json<ApiResponse<never>>({ ok: false, error: { code, message } }, { status });
}

/**
 * Download an `.ics` calendar file.
 *
 * `?sessionId=` exports a single session; omitting it exports the event's whole
 * published schedule. This is intentionally **public and read-only** — golden
 * path step 7 has the public embed offering `.ics` export with a null session.
 * Only scheduled sessions are exposed, and everything is scoped to `eventId`.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const eventId = url.searchParams.get("eventId");
  const sessionId = url.searchParams.get("sessionId");

  if (!eventId) return fail("VALIDATION_ERROR", "eventId is required.", 422);

  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, name: true },
  });
  if (!event) return fail("NOT_FOUND", "Unknown event.", 404);

  const sessions = await prisma.session.findMany({
    where: {
      eventId,
      ...(sessionId ? { id: sessionId } : {}),
      // Only sessions that actually have a time and place can be exported.
      scheduleSlot: { isNot: null },
    },
    select: {
      id: true,
      title: true,
      description: true,
      scheduleSlot: { select: { startsAt: true, endsAt: true, room: { select: { name: true } } } },
    },
    orderBy: { scheduleSlot: { startsAt: "asc" } },
  });

  if (sessions.length === 0) {
    return fail("NOT_FOUND", sessionId ? "That session is not scheduled." : "No scheduled sessions to export.", 404);
  }

  const appUrl = process.env.APP_URL?.replace(/\/$/, "");

  const events: IcsEvent[] = sessions.map((s) => ({
    uid: `${s.id}@greenroom`,
    title: s.title,
    description: s.description,
    location: s.scheduleSlot!.room.name,
    startsAt: s.scheduleSlot!.startsAt,
    endsAt: s.scheduleSlot!.endsAt,
    url: appUrl ? `${appUrl}/embed/schedule` : null,
  }));

  const ics = buildIcsCalendar(events, {
    calendarName: sessionId ? undefined : event.name,
  });

  const filename = sessionId ? icsFilename(sessions[0].title) : icsFilename(event.name);

  return new NextResponse(ics, {
    status: 200,
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      // Schedules change during an event; keep this fresh.
      "cache-control": "no-store",
    },
  });
}
