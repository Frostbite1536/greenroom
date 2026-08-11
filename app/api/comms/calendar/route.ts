import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildIcsCalendar, icsFilename, type IcsEvent } from "@/lib/calendar/ics";
import { PUBLIC_AGENDA_LIMITS } from "@/lib/embed-schedule-view";
import { publicSessionSummary } from "@/lib/public-session-copy";
import { CANONICAL_SCHEDULE_PATH, publicSurfaceUrl } from "@/lib/embed-alias";
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
 * Only scheduled *and published* sessions are exposed, and everything is scoped
 * to `eventId`.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const eventId = url.searchParams.get("eventId");
  const sessionId = url.searchParams.get("sessionId");

  if (!eventId) return fail("VALIDATION_ERROR", "eventId is required.", 422);

  const event = await prisma.event.findUnique({
    where: { id: eventId },
    // `slug` so each VEVENT's URL can point at this event's own programme page
    // rather than whichever one the schedule route defaults to.
    select: { id: true, name: true, slug: true },
  });
  if (!event) return fail("NOT_FOUND", "Unknown event.", 404);

  const rows = await prisma.session.findMany({
    where: {
      eventId,
      ...(sessionId ? { id: sessionId } : {}),
      // Only sessions that actually have a time and place can be exported.
      scheduleSlot: { isNot: null },
      // ...and only ones the event is actually announcing. This endpoint is
      // anonymous and returns a downloadable file, so without this an
      // unpublished talk stays fetchable — and a calendar file, once
      // downloaded, keeps speaking long after the page stopped showing it.
      // Same predicate as `getPublicAgenda` and `GET /api/agenda/public`.
      contentStatus: "PUBLISHED",
    },
    // NEW-1: this was the one anonymous read in the app with no bound at all.
    // Same cap, same predicate and the same cap-plus-one probe as the JSON
    // twin (`GET /api/agenda/public`) and the server-rendered embed, so the
    // three public views of one programme cannot disagree about which sessions
    // fall inside it. `id` breaks `startsAt` ties so the cut is deterministic
    // rather than whatever Postgres returned this time.
    take: PUBLIC_AGENDA_LIMITS.sessions + 1,
    select: {
      id: true,
      title: true,
      description: true,
      scheduleSlot: {
        select: {
          startsAt: true,
          endsAt: true,
          room: { select: { name: true } },
          // The track is the calendar client's grouping/colour hook (CATEGORIES).
          track: { select: { name: true } },
        },
      },
    },
    orderBy: [{ scheduleSlot: { startsAt: "asc" } }, { id: "asc" }],
  });

  const truncated = rows.length > PUBLIC_AGENDA_LIMITS.sessions;
  const sessions = rows.slice(0, PUBLIC_AGENDA_LIMITS.sessions);

  if (sessions.length === 0) {
    // One refusal for "never scheduled" and "not published": distinguishing
    // them would let an anonymous caller detect that a held-back talk exists.
    return fail(
      "NOT_FOUND",
      sessionId ? "That session is not on the published schedule." : "No published sessions to export.",
      404,
    );
  }

  const appUrl = process.env.APP_URL?.replace(/\/$/, "");
  // The canonical public programme, scoped to this event, with the fragment
  // that scrolls to the talk itself. Previously every VEVENT in a 40-session
  // file carried the identical bare embed URL, which told a reader nothing
  // about which row they had clicked.
  const scheduleUrl = appUrl
    ? `${appUrl}${publicSurfaceUrl(CANONICAL_SCHEDULE_PATH, event.slug)}`
    : null;

  const events: IcsEvent[] = sessions.map((s) => ({
    uid: `${s.id}@greenroom`,
    title: s.title,
    // A downloaded .ics keeps speaking long after the page is closed, so it
    // gets the same treatment as the programme page: the speaker's real
    // summary when there is one, the honest fallback when there is not, and an
    // internal provenance note never (§5-4).
    description: publicSessionSummary(s.description),
    location: s.scheduleSlot!.room.name,
    startsAt: s.scheduleSlot!.startsAt,
    endsAt: s.scheduleSlot!.endsAt,
    url: scheduleUrl ? `${scheduleUrl}#session-${s.id}` : null,
    // Only when the talk actually sits on a track; an untracked session gets
    // no CATEGORIES line rather than an empty or invented one.
    categories: s.scheduleSlot!.track ? [s.scheduleSlot!.track.name] : null,
  }));

  const ics = buildIcsCalendar(events, {
    // Named on the single-session file too. A one-event .ics that arrives with
    // no calendar name is filed by the client under an untitled calendar, or
    // silently merged into the user's default one.
    calendarName: event.name,
    // Additive and honest, the same rule the JSON twin's `truncated` flag
    // serves: a reader who imports exactly the cap must be able to tell a
    // complete programme from a cut one. Omitted entirely when nothing was cut.
    ...(truncated
      ? {
          calendarDescription:
            `This file holds the first ${PUBLIC_AGENDA_LIMITS.sessions} sessions of ` +
            `${event.name} in start-time order. The programme has more; see the full schedule online.`,
        }
      : {}),
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
