import Link from "next/link";
import { redirect } from "next/navigation";
import { Search, UserCheck } from "lucide-react";
import "@/components/feature.css";
import { EmptyState, PageHeader, Pill } from "@/components/ui";
import { getApiContext } from "@/lib/api/context";
import { OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import { prisma } from "@/lib/prisma";
import { formatEventDateTime } from "@/lib/tz";
import { headshotAlt, initials } from "@/lib/embed-speaker-view";
import { OnboardingTaskManager } from "@/components/onboarding-task-manager";
import { AddSpeakerDialog, EditSpeakerDialog } from "@/components/speaker-roster-manager";
import {
  compareOnboardingTasks,
  serializeOnboardingTask,
} from "@/lib/services/onboarding-task-view";
import {
  SPEAKER_CONFIRMATION_LABELS,
  SPEAKER_STATUS_FILTERS,
  filterSpeakerStatusRows,
  parseSpeakerStatusFilter,
} from "@/lib/speakers/status";
import { readSpeakerRoster } from "@/lib/speakers/roster-read";
import {
  SPEAKER_SEARCH_MAX_LENGTH,
  filterSpeakerRosterRows,
  parseSpeakerQuery,
  speakerRosterHref,
} from "@/lib/speakers/roster";

export const metadata = { title: "Speaker onboarding" };
export const dynamic = "force-dynamic";

/**
 * Same bounded-read discipline as the operator API routes (INV-EVENT-001). The
 * roster's own three bounds moved to `SPEAKER_ROSTER_LIMITS` with the read; only
 * this page's authoring surfaces are bounded here.
 */
const LIMITS = {
  templates: OPERATOR_QUERY_LIMITS.onboardingTasks,
  forms: OPERATOR_QUERY_LIMITS.importForms,
};

export default async function AdminSpeakersPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; q?: string }>;
}) {
  // Page-level auth: redirect rather than throw, matching the other admin pages.
  const ctx = await getApiContext();
  if (!ctx) redirect("/login");
  if (ctx.role !== "ADMIN") redirect("/portal");

  const params = await searchParams;
  const filter = parseSpeakerStatusFilter(params.filter);
  const query = parseSpeakerQuery(params.q);
  const eventId = ctx.eventId;

  // The roster read is shared with the `/admin` dashboard card that links here,
  // so the two surfaces cannot report different speaker numbers. It runs its own
  // batch, concurrently with this page's two authoring reads.
  const [roster, templates, forms] = await Promise.all([
    readSpeakerRoster(eventId),
    // The authoring surface reads the templates themselves, independently of
    // whether anyone has been assigned them yet.
    prisma.onboardingTask.findMany({
      where: { eventId },
      orderBy: [{ sortOrder: "asc" }, { title: "asc" }, { id: "asc" }],
      take: LIMITS.templates + 1,
      select: { id: true, title: true, description: true, dueAt: true, required: true, formConfigId: true, sortOrder: true },
    }),
    prisma.formConfig.findMany({
      where: { eventId },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: LIMITS.forms + 1,
      select: { id: true, name: true },
    }),
  ]);
  // A missing timezone means the event id names no event; redirect rather than
  // render a roster against a row that is not there.
  if (roster.timezone === null) redirect("/login");
  const timezone = roster.timezone;

  // Same bounded-read discipline as the operator API routes: read one extra row
  // and say so rather than silently authoring against a partial checklist.
  const templatesTruncated = templates.length > LIMITS.templates || forms.length > LIMITS.forms;
  const pagedTemplates = templates.slice(0, LIMITS.templates);
  const pagedTemplateIds = pagedTemplates.map((template) => template.id);

  // Deliberately a second round trip rather than a seventh member of the batch
  // above: these aggregations must be keyed on the ids this page actually
  // renders, which are only known once the capped projection exists. Grouping
  // by event instead would let an oversized event return unbounded groups
  // behind a bounded list — the cap would hold on what is shown while the work
  // behind it grew without limit.
  const [taskCounts, settledCounts] = pagedTemplateIds.length === 0 ? [[], []] : await Promise.all([
    prisma.speakerTask.groupBy({
      by: ["taskId"],
      where: { taskId: { in: pagedTemplateIds }, task: { eventId } },
      _count: { _all: true },
    }),
    prisma.speakerTask.groupBy({
      by: ["taskId"],
      where: { taskId: { in: pagedTemplateIds }, task: { eventId }, status: { in: ["COMPLETED", "WAIVED"] } },
      _count: { _all: true },
    }),
  ]);

  const assignedByTask = new Map(taskCounts.map((row) => [row.taskId, row._count._all]));
  const settledByTask = new Map(settledCounts.map((row) => [row.taskId, row._count._all]));
  const taskTemplates = pagedTemplates
    .map((template) =>
      serializeOnboardingTask(template, timezone, {
        assigned: assignedByTask.get(template.id) ?? 0,
        settled: settledByTask.get(template.id) ?? 0,
      }),
    )
    .sort(compareOnboardingTasks);

  const { rows, summary, awaitingSession, truncated } = roster;
  const searched = filterSpeakerRosterRows(rows, query);
  const visible = filterSpeakerStatusRows(searched, filter);

  return (
    <section className="page-stack">
      <PageHeader
        eyebrow="Speaker operations"
        title="Speaker onboarding"
        description="Everyone this event calls a speaker — on a confirmed session or not — with their profile, onboarding progress, and scheduling status."
        actions={<AddSpeakerDialog />}
      />

      <div className="metric-grid">
        <div className="metric"><span>Confirmed speakers</span><strong>{summary.speakers}</strong></div>
        <div className="metric"><span>Not on a session yet</span><strong>{awaitingSession}</strong></div>
        <div className="metric"><span>Fully onboarded</span><strong>{summary.onboardingComplete} / {summary.speakers}</strong></div>
        <div className="metric"><span>Required tasks open</span><strong>{summary.requiredOutstanding}</strong></div>
        <div className="metric"><span>Speakers overdue</span><strong>{summary.speakersOverdue}</strong></div>
        <div className="metric"><span>Sessions unscheduled</span><strong>{summary.unscheduledSessions}</strong></div>
      </div>

      {templatesTruncated ? (
        <p className="hint" role="status">
          This event has more onboarding tasks or forms than this page loads at once. The checklist below is
          incomplete — reduce the event data before editing it.
        </p>
      ) : null}

      <OnboardingTaskManager
        tasks={taskTemplates}
        forms={forms.slice(0, LIMITS.forms)}
        timezone={timezone}
        confirmedSpeakers={summary.speakers}
      />

      {truncated ? (
        <p className="hint" role="status">
          This event exceeds the bounded read for this page. Speakers whose data could not be fully loaded are
          excluded from the list and totals below — narrow the event data to see everyone.
        </p>
      ) : null}

      <div className="card">
        <div className="table-toolbar roster-toolbar">
          {/* A real GET form, like the public embeds: the page already reads
              `?q=` server-side, so search works with JavaScript disabled and
              every narrowed roster is a shareable URL. The active filter rides
              along in a hidden field, or submitting would silently drop it. */}
          <form className="roster-search-form" method="get" action="/admin/speakers" role="search">
            {filter === "all" ? null : <input type="hidden" name="filter" value={filter} />}
            <label className="speaker-search roster-search">
              <span className="sr-only">Search speakers by name, email, company, job title, bio or session</span>
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                name="q"
                autoComplete="off"
                defaultValue={query}
                maxLength={SPEAKER_SEARCH_MAX_LENGTH}
                placeholder="Search speakers, companies, sessions…"
              />
            </label>
            <button className="ghost-button" type="submit">Search</button>
            {query === "" ? null : (
              <Link className="ghost-button" href={speakerRosterHref({ filter, query: "" })}>Clear</Link>
            )}
          </form>

          <div className="row wrap" role="group" aria-label="Filter speakers">
            {SPEAKER_STATUS_FILTERS.map((option) => {
              // Counted within the active search so the pills and the list
              // below them can never describe different sets of people.
              const count = filterSpeakerStatusRows(searched, option.value).length;
              const active = filter === option.value;
              return (
                // These are links, not toggles: `aria-pressed` is not allowed on
                // an anchor (axe: aria-allowed-attr), so the active filter is
                // marked with `aria-current` instead.
                <Link
                  aria-current={active ? "page" : undefined}
                  className={active ? "ghost-button active" : "ghost-button"}
                  href={speakerRosterHref({ filter: option.value, query })}
                  key={option.value}
                >
                  {option.label}
                  <span className="pill neutral">{count}</span>
                </Link>
              );
            })}
          </div>
        </div>

        {query === "" ? null : (
          <p className="hint roster-search-note" role="status" aria-live="polite">
            {searched.length} of {rows.length} speaker{rows.length === 1 ? "" : "s"} match “{query}”.
          </p>
        )}

        {visible.length === 0 ? (
          <EmptyState
            icon={<UserCheck size={20} aria-hidden="true" />}
            title={query === "" ? "No speakers match this filter" : "No speakers match this search"}
          >
            {rows.length === 0
              ? "Add a speaker above, or accept an abstract and convert it to a session — its speakers appear here."
              : query === ""
                ? "Everyone in this view is up to date."
                : "Try a shorter search, or clear it to see the whole roster."}
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <caption className="sr-only">
                Event speakers with profile, onboarding and scheduling status
              </caption>
              <thead>
                <tr>
                  <th scope="col">Speaker</th>
                  <th scope="col">Sessions</th>
                  <th scope="col">Profile</th>
                  <th scope="col">Onboarding tasks</th>
                  <th scope="col">Next required due</th>
                  <th scope="col">Status</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const taskPercent = row.tasksTotal === 0 ? 100 : Math.round((row.tasksDone / row.tasksTotal) * 100);
                  return (
                    <tr key={row.userId}>
                      <td>
                        <div className="roster-identity">
                          {/* The stored headshot, or this speaker's own
                              initials. Never a stand-in portrait: an invented
                              face is worse than an honest blank. */}
                          {row.headshotUrl ? (
                            <img
                              className="roster-avatar"
                              src={row.headshotUrl}
                              alt={headshotAlt(row.name)}
                              width={40}
                              height={40}
                              loading="lazy"
                            />
                          ) : (
                            <span className="roster-avatar roster-avatar-fallback" aria-hidden="true">
                              {initials(row.name)}
                            </span>
                          )}
                          <div className="roster-identity-copy">
                            <div className="cell-title">{row.name}</div>
                            <div className="cell-sub">
                              {row.email}
                              {row.jobTitle ? ` · ${row.jobTitle}` : ""}
                              {row.company ? ` · ${row.company}` : ""}
                            </div>
                            {row.bio ? (
                              <p className="cell-sub roster-bio">{row.bio}</p>
                            ) : (
                              <p className="cell-sub roster-bio-missing">No bio stored yet</p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td>
                        {row.sessionCount === 0 ? (
                          <span className="muted">Not on a session yet</span>
                        ) : (
                          <>
                            <div>{row.scheduledCount} / {row.sessionCount} scheduled</div>
                            <div className="cell-sub">{row.sessionTitles.join(", ")}</div>
                          </>
                        )}
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
                        {/* The deadline the operator is actually chasing: the
                            earliest one still owed, rendered in the event's own
                            zone so it matches what the speaker sees in the
                            portal (C12). */}
                        {row.nextRequiredDueAt
                          ? formatEventDateTime(row.nextRequiredDueAt, timezone)
                          : <span className="muted">{row.requiredOutstanding.length > 0 ? "No deadline" : "Nothing owed"}</span>}
                        {row.overdueRequired > 0 ? (
                          <div className="cell-sub">
                            <Pill tone="bad">{row.overdueRequired} overdue</Pill>
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {/* Whether they have said yes comes first: no amount of
                            finished onboarding makes a declined speaker ready. */}
                        {row.status === "CONFIRMED" ? null : (
                          <Pill tone={row.status === "DECLINED" ? "bad" : "warn"}>
                            {SPEAKER_CONFIRMATION_LABELS[row.status]}
                          </Pill>
                        )}
                        {row.onboardingComplete ? (
                          <Pill tone="good">Ready</Pill>
                        ) : row.requiredOutstanding.length > 0 ? (
                          <Pill tone="warn">Onboarding open</Pill>
                        ) : (
                          <Pill tone="info">Profile incomplete</Pill>
                        )}
                        {row.scheduledCount < row.sessionCount ? <Pill tone="neutral">Unscheduled</Pill> : null}
                        {row.sessionCount === 0 ? <Pill tone="neutral">Awaiting session</Pill> : null}
                      </td>
                      <td>
                        <EditSpeakerDialog
                          speaker={{
                            userId: row.userId,
                            name: row.name,
                            email: row.email,
                            jobTitle: row.jobTitle,
                            company: row.company,
                            bio: row.bio,
                            headshotUrl: row.headshotUrl,
                            status: row.status,
                          }}
                        />
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
