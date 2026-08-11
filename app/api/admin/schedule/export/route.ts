import { requireContext } from "@/lib/api/context";
import { handle } from "@/lib/api/http";
import { readAgendaData } from "@/lib/data/reads";
import {
  buildScheduleExportCsv,
  scheduleExportFilename,
  type ScheduleExportRow,
} from "@/lib/services/reports-export-csv";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/schedule/export — ADMIN-only `text/csv` of the placed
 * programme, one row per slot (D-C5-16 #4). Same conventions as the ABS-13
 * export: attachment, dated input-free filename, formula-neutralized cells, a
 * header row pinned by test, bounded read with its own truncation notice.
 *
 * Slot-centric on purpose, which is what makes it different from the sessions
 * export beside it: an unplaced talk has no day, no room and no time, so it is
 * not a schedule row at all and is absent here. It is in the sessions export,
 * flagged `scheduled=no`.
 *
 * Rows are ordered by start instant with a stable tie-break, so re-exporting an
 * unchanged event produces a byte-identical file. Local day and clock times are
 * rendered in the EVENT's stored zone through `lib/tz`, never the server's:
 * a schedule read in the wrong zone is a different schedule.
 *
 * Speaker names only, for the same reason as the sessions export.
 */
export const GET = handle(async () => {
  const ctx = await requireContext(["ADMIN"]);
  const agenda = await readAgendaData(ctx.eventId);

  const roomName = new Map(agenda.rooms.map((room) => [room.id, room.name]));
  const trackName = new Map(agenda.tracks.map((track) => [track.id, track.name]));

  const rows: ScheduleExportRow[] = agenda.sessions
    .flatMap((session) =>
      session.slot
        ? [{
            startsAt: session.slot.startsAt,
            endsAt: session.slot.endsAt,
            roomName: roomName.get(session.slot.roomId) ?? "Room",
            trackName: session.slot.trackId ? trackName.get(session.slot.trackId) ?? null : null,
            sessionTitle: session.title,
            speakerNames: session.speakers.map((speaker) => speaker.name),
          }]
        : [],
    )
    .sort((left, right) =>
      left.startsAt.localeCompare(right.startsAt)
      || left.roomName.localeCompare(right.roomName)
      || left.sessionTitle.localeCompare(right.sessionTitle));

  return new Response(
    buildScheduleExportCsv({ rows, truncated: agenda.truncated, timezone: agenda.timezone }),
    {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${scheduleExportFilename()}"`,
        "cache-control": "no-store",
      },
    },
  );
});
