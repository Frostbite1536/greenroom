import Link from "next/link";
import {
  CalendarClock,
  ClipboardCheck,
  Download,
  FileStack,
  UserCheck,
} from "lucide-react";
import "@/components/feature.css";
import { ReportChart } from "@/components/report-charts";
import { EmptyState, PageHeader, Pill } from "@/components/ui";
import { getAdminReports } from "@/lib/data/reads";
import {
  categoryFunnelChart,
  reviewLoadChart,
  scheduleUtilizationChart,
  submissionPacingChart,
  speakerReadinessChart,
} from "@/lib/reports/charts";
import {
  formatMinutes,
  formatRate,
  FUNNEL_COLUMNS,
} from "@/lib/reports/metrics";
import { formatDayLabel, minutesToTimeInput } from "@/lib/tz";

export const metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

/**
 * The organizer's process report: how the call, the reviewing, the room plan and
 * the speaker onboarding actually performed.
 *
 * Deliberately NOT the dashboard. `/admin` answers "where does my programme
 * stand right now" with one number per workspace and a link into it; this page
 * answers "how did the process perform" by breaking those same populations down
 * — by category, by reviewer, by room and day, by readiness — and hands the
 * whole dataset over as CSV. No card here restates a dashboard card.
 *
 * A pure server component. Every number is read once, server-side, by
 * `getAdminReports()`, which borrows each definition from the screen that owns
 * it; nothing on this page is interactive, so there is no client component here
 * at all. The export buttons are plain anchors, because the browser handles a
 * `Content-Disposition` download and the server stays the only place that
 * decides what a CSV may contain.
 *
 * Authorization is `pageContext(["ADMIN"])` inside that read, the same
 * redirect-rather-than-throw pattern every sibling admin page uses.
 */
export default async function AdminReportsPage() {
  const view = await getAdminReports();
  const { pacing, funnel, review, utilization, readiness } = view;

  const hasSubmissions = funnel.totals.total > 0;
  const bookedMinutes = utilization.reduce((sum, day) => sum + day.bookedMinutes, 0);

  // Charts, built from the folds already read above — pure, synchronous, and
  // null wherever there is nothing honest to draw, so a section falls back to
  // its own empty state rather than a row of zero-width bars. Each one sits
  // above the table holding the same numbers; the table stays the truth.
  const funnelChart = categoryFunnelChart(funnel);
  const pacingChart = submissionPacingChart(pacing);
  const pacingRange = pacing.rows.length === 0
    ? null
    : `${formatDayLabel(pacing.rows[0].dateKey, view.timezone)}–${formatDayLabel(pacing.rows.at(-1)!.dateKey, view.timezone)}`;
  const reviewChart = reviewLoadChart(review);
  const readinessChart = speakerReadinessChart(readiness);
  const utilizationCharts = utilization.flatMap((day) => {
    const label = formatDayLabel(day.dateKey, view.timezone);
    const chart = scheduleUtilizationChart(day, label);
    if (!chart) return [];
    const heading = day.startMinutes === null || day.endMinutes === null
      ? label
      : `${label} · ${minutesToTimeInput(day.startMinutes)}–${minutesToTimeInput(day.endMinutes)}`;
    return [{ key: day.dateKey, heading, chart }];
  });

  return (
    <section className="page-stack" style={{ width: "min(1280px, 100%)" }}>
      <PageHeader
        eyebrow="Process reporting"
        title="Reports"
        description={`How ${view.eventName} ran: submission pacing, acceptance by topic, review load by reviewer, room time by day, and speaker readiness.`}
      />

      <div className="metric-grid">
        <div className="metric">
          <span>Submissions received</span>
          <strong>{view.pacingTruncated ? `${pacing.total}+` : pacing.total}</strong>
        </div>
        <div className="metric">
          <span>Acceptance rate</span>
          <strong>{formatRate(funnel.totals.acceptanceRate)}</strong>
        </div>
        <div className="metric">
          <span>Reviews outstanding</span>
          <strong>{review.assigned === 0 ? "—" : review.outstanding}</strong>
        </div>
        <div className="metric">
          <span>Program time booked</span>
          <strong>{formatMinutes(bookedMinutes)}</strong>
        </div>
      </div>

      {/* ---- 0. Submission pacing ---- */}
      <section className="work-panel" aria-labelledby="reports-pacing">
        <div className="panel-heading">
          <div>
            <h2 id="reports-pacing">Submission pacing</h2>
            <p>
              Proposals received per event-local day, based only on their submission timestamp.
              Draft creation is not counted as demand, and the cumulative column shows how the call built over time.
            </p>
            {pacingRange ? <p className="hint">Covered range: {pacingRange} ({view.timezone}).</p> : null}
          </div>
          <Link className="ghost-button" href="/admin/abstracts">All proposals</Link>
        </div>
        {pacingChart ? (
          <ReportChart
            chart={pacingChart}
            caption="Bar length compares each day’s received proposals with the peak day; the exact daily and cumulative figures remain in the table."
          />
        ) : (
          <EmptyState icon={<FileStack aria-hidden="true" size={22} />} title="No submitted proposals yet">
            Saved drafts do not count as received work. The first submitted proposal starts this timeline.
          </EmptyState>
        )}
        {pacing.rows.length === 0 ? null : (
          <div className="table-scroll">
            <table className="data-table report-table">
              <caption className="sr-only">Submitted proposals per event-local day with cumulative total</caption>
              <thead><tr><th scope="col">Day</th><th scope="col">Submitted</th><th scope="col">Cumulative</th></tr></thead>
              <tbody>
                {pacing.rows.map((row) => (
                  <tr key={row.dateKey}>
                    <th scope="row">{formatDayLabel(row.dateKey, view.timezone)}</th>
                    <td className="report-number">{row.submitted}</td>
                    <td className="report-number">{row.cumulative}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {view.pacingTruncated ? (
          <p className="hint dashboard-note" role="status">
            Showing at most the latest 5,000 submitted proposals across the latest 366 calendar days. This pacing curve and cumulative total are floors; earlier activity is not shown.
          </p>
        ) : null}
      </section>

      {/* ---- 1. Per-category funnel ---- */}
      <section className="work-panel" aria-labelledby="reports-funnel">
        <div className="panel-heading">
          <div>
            <h2 id="reports-funnel">Submissions by category</h2>
            <p>
              Every proposal by topic and status, counted exactly as the abstracts table counts them.
              Acceptance is accepted ÷ decided, where a decision means accepted or declined — a maybe is
              still under consideration and a withdrawal was never the committee&rsquo;s call.
            </p>
          </div>
          <div className="row wrap">
            <Link className="ghost-button" href="/admin/abstracts">All proposals</Link>
            <a className="ghost-button" href="/api/admin/abstracts/export" download
              title="Download the loaded proposals and their decision scores as CSV">
              <Download size={15} aria-hidden="true" /> Review results CSV
            </a>
          </div>
        </div>
        {funnelChart ? (
          <ReportChart
            chart={funnelChart}
            caption="Bar length is the category’s proposal count, split by status. The figure beside each bar is that category’s total and its acceptance rate."
          />
        ) : null}
        {!hasSubmissions ? (
          <EmptyState icon={<FileStack size={22} />} title="No proposals yet">
            Categories break down the call once proposals arrive.{" "}
            <Link href="/admin/forms">Publish a form</Link> to open it, or{" "}
            <Link href="/admin/settings">add categories</Link> so the breakdown has topics to report on.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="data-table report-table">
              <caption className="sr-only">Proposals by category and status, with acceptance rate</caption>
              <thead>
                <tr>
                  <th scope="col">Category</th>
                  {FUNNEL_COLUMNS.map((column) => (
                    <th scope="col" key={column.status}>{column.label}</th>
                  ))}
                  <th scope="col">Decided</th>
                  <th scope="col">Acceptance</th>
                </tr>
              </thead>
              <tbody>
                {funnel.rows.map((row) => (
                  <tr key={row.categoryId ?? "uncategorized"}>
                    <th scope="row">{row.categoryName}</th>
                    {FUNNEL_COLUMNS.map((column) => (
                      <td className="report-number" key={column.status}>{row.counts[column.status]}</td>
                    ))}
                    <td className="report-number">{row.decided}</td>
                    <td className="report-number">{formatRate(row.acceptanceRate)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">All categories</th>
                  {FUNNEL_COLUMNS.map((column) => (
                    <td className="report-number" key={column.status}>{funnel.totals.counts[column.status]}</td>
                  ))}
                  <td className="report-number">{funnel.totals.decided}</td>
                  <td className="report-number">{formatRate(funnel.totals.acceptanceRate)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      {/* ---- 2. Review load ---- */}
      <section className="work-panel" aria-labelledby="reports-review">
        <div className="panel-heading">
          <div>
            <h2 id="reports-review">Review load</h2>
            <p>
              What each reviewer was given and how much of it is done. Withdrawn proposals are excluded, as
              on the evaluation screen. Scores and which proposal a reviewer holds are deliberately absent —
              this reports workload, never opinions, and there is no CSV of it for the same reason.
            </p>
          </div>
          <Link className="ghost-button" href="/admin/evaluations">Evaluation</Link>
        </div>
        {reviewChart ? (
          <ReportChart
            chart={reviewChart}
            caption="Bar length is the reviewer’s assigned count, filled by how much of it is done. Most outstanding first, as in the table."
          />
        ) : null}
        {review.rows.length === 0 ? (
          <EmptyState icon={<ClipboardCheck size={22} />} title="No reviewers yet">
            Load is measured per reviewer.{" "}
            <Link href="/admin/evaluations">Invite reviewers and assign a round</Link> to start.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="data-table report-table">
              <caption className="sr-only">Assigned, completed and outstanding reviews per reviewer</caption>
              <thead>
                <tr>
                  <th scope="col">Reviewer</th>
                  <th scope="col">Assigned</th>
                  <th scope="col">Completed</th>
                  <th scope="col">Outstanding</th>
                  <th scope="col">Progress</th>
                </tr>
              </thead>
              <tbody>
                {review.rows.map((row) => (
                  <tr key={row.userId}>
                    <th scope="row">{row.name}</th>
                    <td className="report-number">{row.assigned}</td>
                    <td className="report-number">{row.completed}</td>
                    <td className="report-number">
                      {row.outstanding === 0 ? 0 : <Pill tone="warn">{row.outstanding}</Pill>}
                    </td>
                    <td>
                      {row.assigned === 0 ? (
                        <span className="muted">Nothing assigned</span>
                      ) : (
                        <>
                          <div
                            className="progress-bar"
                            role="img"
                            aria-label={`${row.completed} of ${row.assigned} reviews complete`}
                          >
                            <span style={{ width: `${Math.round((row.completionRate ?? 0) * 100)}%` }} />
                          </div>
                          <div className="cell-sub">{formatRate(row.completionRate)}</div>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">All reviewers</th>
                  <td className="report-number">{review.assigned}</td>
                  <td className="report-number">{review.completed}</td>
                  <td className="report-number">{review.outstanding}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {view.reviewersTruncated ? (
          <p className="hint dashboard-note" role="status">
            This event has more members than one read loads, so the reviewers listed above are a subset and
            every total is a floor.
          </p>
        ) : null}
      </section>

      {/* ---- 3. Schedule utilization ---- */}
      <section className="work-panel" aria-labelledby="reports-utilization">
        <div className="panel-heading">
          <div>
            <h2 id="reports-utilization">Room utilization</h2>
            <p>
              Minutes booked per room against each day&rsquo;s program span — first start to last end across
              all rooms, in {view.timezone}. Booked time is the placed slot&rsquo;s own length, so the room that
              defines a day&rsquo;s span reads 100% and an idle room reads zero.
            </p>
          </div>
          <div className="row wrap">
            <a className="ghost-button" href="/api/admin/schedule/export" download
              title="Download every placed slot as CSV">
              <Download size={15} aria-hidden="true" /> Schedule CSV
            </a>
            <a className="ghost-button" href="/api/admin/sessions/export" download
              title="Download every talk, placed or not, as CSV">
              <Download size={15} aria-hidden="true" /> Sessions CSV
            </a>
          </div>
        </div>
        {utilizationCharts.map((entry, index) => (
          <ReportChart
            key={entry.key}
            chart={entry.chart}
            heading={entry.heading}
            caption={index === 0
              ? "Each bar is one room’s booked minutes against that day’s program span, so the room that defines the span reads 100%."
              : undefined}
          />
        ))}
        {view.placedSlots === 0 ? (
          <EmptyState icon={<CalendarClock size={22} />} title="Nothing is placed yet">
            Utilization is measured from placed slots.{" "}
            <Link href="/admin/agenda">Place a talk in the agenda builder</Link> to start the report.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="data-table report-table">
              <caption className="sr-only">Slots and minutes booked per room, by event day</caption>
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col">Room</th>
                  <th scope="col">Slots</th>
                  <th scope="col">Booked</th>
                  <th scope="col">Day span</th>
                  <th scope="col">Utilization</th>
                </tr>
              </thead>
              <tbody>
                {utilization.map((day) =>
                  day.rooms.map((room, index) => (
                    <tr key={`${day.dateKey}:${room.roomId}`}>
                      {index === 0 ? (
                        <th scope="row" rowSpan={day.rooms.length || 1}>
                          <div className="cell-title">{formatDayLabel(day.dateKey, view.timezone)}</div>
                          <div className="cell-sub">
                            {day.startMinutes === null || day.endMinutes === null
                              ? "Nothing placed"
                              : `${minutesToTimeInput(day.startMinutes)}–${minutesToTimeInput(day.endMinutes)}`}
                          </div>
                        </th>
                      ) : null}
                      <td>{room.roomName}</td>
                      <td className="report-number">{room.slots}</td>
                      <td className="report-number">{formatMinutes(room.bookedMinutes)}</td>
                      <td className="report-number">{formatMinutes(day.spanMinutes)}</td>
                      <td className="report-number">{formatRate(room.utilization)}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
        {view.rooms.length === 0 ? (
          <p className="hint dashboard-note" role="status">
            This event has no rooms yet, so there is nothing to measure a day against —{" "}
            <Link href="/admin/settings">add a room</Link> first.
          </p>
        ) : null}
        {view.agendaTruncated ? (
          <p className="hint dashboard-note" role="status">
            This event holds more talks than one read loads, so every figure above is a floor and slots that
            were not loaded are missing from it.
          </p>
        ) : null}
      </section>

      {/* ---- 4. Speaker readiness ---- */}
      <section className="work-panel" aria-labelledby="reports-readiness">
        <div className="panel-heading">
          <div>
            <h2 id="reports-readiness">Speaker readiness</h2>
            <p>
              Where the confirmed-session cohort sits on the roster&rsquo;s own readiness ladder, plus whether
              each person has accepted their invitation. Measured exactly as the roster measures it.
            </p>
          </div>
          <div className="row wrap">
            <Link className="ghost-button" href="/admin/speakers">Speaker onboarding</Link>
            <a className="ghost-button" href="/api/admin/speakers/export" download
              title="Download the speaker roster as CSV">
              <Download size={15} aria-hidden="true" /> Speakers CSV
            </a>
          </div>
        </div>
        {readinessChart ? (
          <ReportChart
            chart={readinessChart}
            caption="One bar, the whole confirmed-session cohort, split by where each speaker sits on the roster’s readiness ladder."
          />
        ) : null}
        {readiness.cohort === 0 && readiness.awaitingSession === 0 ? (
          <EmptyState icon={<UserCheck size={22} />} title="No speakers yet">
            Accepting a proposal names its speakers, or{" "}
            <Link href="/admin/speakers">add one to the roster</Link> before the call closes.
          </EmptyState>
        ) : (
          <>
            <ul className="dashboard-list">
              {readiness.buckets.map((bucket) => (
                <li key={bucket.key}>
                  <Link href="/admin/speakers?filter=incomplete-onboarding">
                    <Pill tone={bucket.tone}>{bucket.label}</Pill>
                    <strong>{bucket.count} / {readiness.cohort}</strong>
                  </Link>
                </li>
              ))}
              {readiness.confirmation.map((row) => (
                <li key={row.status}>
                  <Link href="/admin/speakers">
                    <span className="dashboard-row-label">
                      {row.status === "CONFIRMED" ? "Confirmed the invitation" : row.status === "INVITED" ? "Invited, not yet confirmed" : "Declined"}
                    </span>
                    <strong>{row.count}</strong>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="dashboard-note">
              {readiness.awaitingSession === 0
                ? "Every speaker on the roster is on at least one talk."
                : `${readiness.awaitingSession} named speaker${readiness.awaitingSession === 1 ? " is" : "s are"} not on a talk yet, so they sit outside the readiness figures above.`}
              {readiness.overdue > 0
                ? ` ${readiness.overdue} speaker${readiness.overdue === 1 ? " holds" : "s hold"} a required task past its deadline.`
                : ""}
            </p>
          </>
        )}
        {view.rosterTruncated ? (
          <p className="hint dashboard-note" role="status">
            This event exceeds the roster&rsquo;s bounded read, so the speaker figures above are floors.
          </p>
        ) : null}
      </section>
    </section>
  );
}
