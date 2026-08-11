import { requireContext } from "@/lib/api/context";
import { handle } from "@/lib/api/http";
import { readSpeakerRoster } from "@/lib/speakers/roster-read";
import {
  buildSpeakerExportCsv,
  speakerExportFilename,
  type SpeakerExportRow,
} from "@/lib/services/reports-export-csv";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/speakers/export — ADMIN-only `text/csv` of the roster shown on
 * `/admin/speakers` (D-C5-16 #4), following the ABS-13 export's conventions
 * exactly: attachment with a dated, input-free filename, formula-neutralized
 * cells, a documented header row pinned by test, and a bounded read that states
 * its own truncation in the file rather than returning a silently short one.
 *
 * No projection is written here. `readSpeakerRoster()` is the one read behind
 * both `/admin/speakers` and the `/admin` dashboard's speaker card, so this
 * export cannot describe a different roster than either screen — including its
 * bounds and its rule for excluding partially-loaded speakers.
 *
 * Email IS a column: the roster prints it under every name, and a contact
 * export without it is not the CRM-parity export this closes the gap for. Bio
 * and headshot URL are deliberately NOT columns — narrower than the screen,
 * which is always allowed; wider is not.
 */
export const GET = handle(async () => {
  const ctx = await requireContext(["ADMIN"]);
  const roster = await readSpeakerRoster(ctx.eventId);

  const rows: SpeakerExportRow[] = roster.rows.map((row) => ({
    name: row.name,
    email: row.email,
    company: row.company,
    jobTitle: row.jobTitle,
    status: row.status,
    sessionCount: row.sessionCount,
    scheduledCount: row.scheduledCount,
    sessionTitles: row.sessionTitles,
    profilePercent: row.profilePercent,
    profileMissing: row.profileMissing,
    tasksDone: row.tasksDone,
    tasksTotal: row.tasksTotal,
    requiredOutstanding: row.requiredOutstanding,
    nextRequiredDueAt: row.nextRequiredDueAt,
    overdueRequired: row.overdueRequired,
    onboardingComplete: row.onboardingComplete,
  }));

  return new Response(
    buildSpeakerExportCsv({ rows, truncated: roster.truncated }),
    {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${speakerExportFilename()}"`,
        // Live operator data, not a cacheable document.
        "cache-control": "no-store",
      },
    },
  );
});
