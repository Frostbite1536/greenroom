import Link from "next/link";
import { redirect } from "next/navigation";
import { UserCheck } from "lucide-react";
import "@/components/feature.css";
import { EmptyState, PageHeader, Pill } from "@/components/ui";
import { getApiContext } from "@/lib/api/context";
import { OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import { prisma } from "@/lib/prisma";
import {
  SPEAKER_STATUS_FILTERS,
  buildSpeakerStatusRows,
  filterSpeakerStatusRows,
  parseSpeakerStatusFilter,
  summarizeSpeakerStatus,
  type SpeakerAssignment,
  type SpeakerTaskAssignment,
} from "@/lib/speakers/status";

export const metadata = { title: "Speaker onboarding" };
export const dynamic = "force-dynamic";

/** Same bounded-read discipline as the operator API routes (INV-EVENT-001). */
const LIMITS = {
  assignments: OPERATOR_QUERY_LIMITS.reminderSessionSpeakers,
  taskAssignments: OPERATOR_QUERY_LIMITS.reminderSessionSpeakers * 10,
};

export default async function AdminSpeakersPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  // Page-level auth: redirect rather than throw, matching the other admin pages.
  const ctx = await getApiContext();
  if (!ctx) redirect("/login");
  if (ctx.role !== "ADMIN") redirect("/portal");

  const filter = parseSpeakerStatusFilter((await searchParams).filter);
  const eventId = ctx.eventId;

  // Speakers on confirmed sessions only: a Session exists exactly when an
  // abstract was accepted or a talk was guaranteed, so this is the onboarding
  // cohort. Both reads are event-scoped and bounded.
  const [sessionSpeakers, speakerTasks] = await Promise.all([
    prisma.sessionSpeaker.findMany({
      where: { session: { eventId } },
      select: {
        userId: true,
        user: {
          select: {
            name: true,
            email: true,
            speakerProfile: { select: { bio: true, company: true, jobTitle: true, headshotUrl: true } },
          },
        },
        session: { select: { id: true, title: true, scheduleSlot: { select: { id: true } } } },
      },
      orderBy: [{ userId: "asc" }, { sessionId: "asc" }],
      take: LIMITS.assignments + 1,
    }),
    prisma.speakerTask.findMany({
      where: { task: { eventId } },
      select: {
        userId: true,
        status: true,
        task: { select: { id: true, title: true, required: true, sortOrder: true } },
      },
      orderBy: [{ userId: "asc" }, { task: { sortOrder: "asc" } }],
      take: LIMITS.taskAssignments + 1,
    }),
  ]);

  const truncated = sessionSpeakers.length > LIMITS.assignments || speakerTasks.length > LIMITS.taskAssignments;

  const assignments: SpeakerAssignment[] = sessionSpeakers.slice(0, LIMITS.assignments).map((row) => ({
    userId: row.userId,
    name: row.user.name,
    email: row.user.email,
    profile: row.user.speakerProfile,
    sessionId: row.session.id,
    sessionTitle: row.session.title,
    scheduled: row.session.scheduleSlot !== null,
  }));
  const taskAssignments: SpeakerTaskAssignment[] = speakerTasks.slice(0, LIMITS.taskAssignments).map((row) => ({
    userId: row.userId,
    taskId: row.task.id,
    taskTitle: row.task.title,
    status: row.status,
    required: row.task.required,
  }));

  const rows = buildSpeakerStatusRows(assignments, taskAssignments);
  const summary = summarizeSpeakerStatus(rows);
  const visible = filterSpeakerStatusRows(rows, filter);

  return (
    <section className="page-stack">
      <PageHeader
        eyebrow="Speaker operations"
        title="Speaker onboarding"
        description="Every speaker on a confirmed session, with profile completeness, onboarding progress, and scheduling status."
      />

      <div className="metric-grid">
        <div className="metric"><span>Speakers</span><strong>{summary.speakers}</strong></div>
        <div className="metric"><span>Fully onboarded</span><strong>{summary.onboardingComplete} / {summary.speakers}</strong></div>
        <div className="metric"><span>Required tasks open</span><strong>{summary.requiredOutstanding}</strong></div>
        <div className="metric"><span>Sessions unscheduled</span><strong>{summary.unscheduledSessions}</strong></div>
      </div>

      {truncated ? (
        <p className="hint" role="status">
          This event exceeds the bounded read for this page, so the list below is partial. Narrow the event data before
          relying on these totals.
        </p>
      ) : null}

      <div className="card">
        <div className="table-toolbar">
          <div className="row wrap" role="group" aria-label="Filter speakers">
            {SPEAKER_STATUS_FILTERS.map((option) => {
              const count = filterSpeakerStatusRows(rows, option.value).length;
              return (
                <Link
                  aria-pressed={filter === option.value}
                  className="ghost-button"
                  href={option.value === "all" ? "/admin/speakers" : `/admin/speakers?filter=${option.value}`}
                  key={option.value}
                >
                  {option.label}
                  <span className="pill neutral">{count}</span>
                </Link>
              );
            })}
          </div>
        </div>

        {visible.length === 0 ? (
          <EmptyState icon={<UserCheck size={20} aria-hidden="true" />} title="No speakers match this filter">
            {rows.length === 0
              ? "Accept an abstract and convert it to a session — its speakers appear here."
              : "Everyone in this view is up to date."}
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <caption className="sr-only">
                Speakers on confirmed sessions with onboarding and scheduling status
              </caption>
              <thead>
                <tr>
                  <th scope="col">Speaker</th>
                  <th scope="col">Sessions</th>
                  <th scope="col">Profile</th>
                  <th scope="col">Onboarding tasks</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const taskPercent = row.tasksTotal === 0 ? 100 : Math.round((row.tasksDone / row.tasksTotal) * 100);
                  return (
                    <tr key={row.userId}>
                      <td>
                        <div className="cell-title">{row.name}</div>
                        <div className="cell-sub">{row.email}{row.company ? ` · ${row.company}` : ""}</div>
                      </td>
                      <td>
                        <div>{row.scheduledCount} / {row.sessionCount} scheduled</div>
                        <div className="cell-sub">{row.sessionTitles.join(", ")}</div>
                      </td>
                      <td>
                        <div className="progress-bar" role="img" aria-label={`Profile ${row.profilePercent}% complete`}>
                          <span style={{ width: `${row.profilePercent}%` }} />
                        </div>
                        <div className="cell-sub">
                          {row.profileMissing.length === 0 ? "Complete" : `Missing: ${row.profileMissing.join(", ")}`}
                        </div>
                      </td>
                      <td>
                        <div className="progress-bar" role="img" aria-label={`Onboarding ${row.tasksDone} of ${row.tasksTotal} done`}>
                          <span style={{ width: `${taskPercent}%` }} />
                        </div>
                        <div className="cell-sub">
                          {row.tasksDone} / {row.tasksTotal} done
                          {row.requiredOutstanding.length > 0 ? ` · required open: ${row.requiredOutstanding.join(", ")}` : ""}
                        </div>
                      </td>
                      <td>
                        {row.onboardingComplete ? (
                          <Pill tone="good">Ready</Pill>
                        ) : row.requiredOutstanding.length > 0 ? (
                          <Pill tone="warn">Onboarding open</Pill>
                        ) : (
                          <Pill tone="info">Profile incomplete</Pill>
                        )}
                        {row.scheduledCount < row.sessionCount ? <Pill tone="neutral">Unscheduled</Pill> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
