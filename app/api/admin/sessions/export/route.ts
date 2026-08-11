import { requireContext } from "@/lib/api/context";
import { handle } from "@/lib/api/http";
import { readAgendaData } from "@/lib/data/reads";
import {
  buildSessionExportCsv,
  sessionExportFilename,
  type SessionExportRow,
} from "@/lib/services/reports-export-csv";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/sessions/export — ADMIN-only `text/csv` of every talk on this
 * event, placed or not (D-C5-16 #4). Same conventions as the ABS-13 export:
 * attachment, dated input-free filename, formula-neutralized cells, a header
 * row pinned by test, and a bounded read that names its own truncation.
 *
 * `readAgendaData()` is the agenda builder's own read, so this file lists the
 * same programme the builder lays out, with the same cap and the same
 * truncation rule. Room and track are resolved from that read's own rooms and
 * tracks rather than re-queried, which is what stops a renamed room appearing
 * under two names across two surfaces.
 *
 * Speaker NAMES only. `/admin/agenda` shows no speaker email and neither does
 * the decision export; a talk listing is not a contact list, and the speakers
 * export is where a contact list belongs.
 */
export const GET = handle(async () => {
  const ctx = await requireContext(["ADMIN"]);
  const agenda = await readAgendaData(ctx.eventId);

  const roomName = new Map(agenda.rooms.map((room) => [room.id, room.name]));
  const trackName = new Map(agenda.tracks.map((track) => [track.id, track.name]));

  const rows: SessionExportRow[] = agenda.sessions.map((session) => ({
    id: session.id,
    title: session.title,
    contentStatus: session.contentStatus,
    format: session.format,
    durationMinutes: session.durationMinutes,
    categoryName: session.category?.name ?? null,
    trackName: session.slot?.trackId ? trackName.get(session.slot.trackId) ?? null : null,
    roomName: session.slot ? roomName.get(session.slot.roomId) ?? null : null,
    startsAt: session.slot?.startsAt ?? null,
    endsAt: session.slot?.endsAt ?? null,
    speakerNames: session.speakers.map((speaker) => speaker.name),
  }));

  return new Response(
    buildSessionExportCsv({ rows, truncated: agenda.truncated }),
    {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${sessionExportFilename()}"`,
        "cache-control": "no-store",
      },
    },
  );
});
