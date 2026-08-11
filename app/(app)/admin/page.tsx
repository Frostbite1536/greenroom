import Link from "next/link";
import {
  AlertTriangle,
  CalendarDays,
  ClipboardCheck,
  FileStack,
  FileText,
  UserCheck,
} from "lucide-react";
import "@/components/feature.css";
import { EmptyState, PageHeader, Pill } from "@/components/ui";
import { getAdminDashboard } from "@/lib/data/reads";
import { OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import { ABSTRACT_STATUS_META } from "@/lib/abstract-status";
import { boundedCount, boundedCountLabel } from "@/lib/bounded-count";
import { roundLabel } from "@/lib/round-label";
import { formatEventDateTime } from "@/lib/tz";

export const metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

/**
 * The organizer's landing view: where the programme stands right now.
 *
 * A pure server component. Every number is read once, server-side, by
 * `getAdminDashboard()` — which borrows each definition from the screen the
 * card links to rather than inventing its own — and nothing on this page is
 * interactive, so there is no client component here at all. Counts and links
 * do not need one.
 *
 * Authorization is `pageContext(["ADMIN"])` inside that read, the same
 * redirect-rather-than-throw pattern every sibling admin page uses.
 */
export default async function AdminDashboardPage() {
  const view = await getAdminDashboard();
  const { funnel, forms, review, programme, speakers, recentSubmissions, recentDecisions } = view;

  const hasForms = forms.total > 0;
  const hasSubmissions = funnel.total > 0;

  return (
    <section className="page-stack" style={{ width: "min(1280px, 100%)" }}>
      <PageHeader
        eyebrow="Event overview"
        title="Dashboard"
        description={`Where ${view.eventName} stands right now — the call, the reviewing, the programme and your speakers, each linking to the workspace that owns it.`}
      />

      <div className="metric-grid">
        <div className="metric">
          <span>Submissions</span>
          <strong>{funnel.submitted}</strong>
        </div>
        <div className="metric">
          <span>Reviews completed</span>
          <strong>{review.assigned === 0 ? "—" : `${review.completed} / ${review.assigned}`}</strong>
        </div>
        <div className="metric">
          <span>Talks scheduled</span>
          <strong>
            {programme.sessions === 0
              ? "—"
              : `${boundedCount(programme.scheduled, programme.truncated)} / ${boundedCount(programme.sessions, programme.truncated)}`}
          </strong>
        </div>
      </div>

      <div className="dashboard-grid">
        {/* ---- 1. CFP funnel ---- */}
        <section className="work-panel dashboard-panel" aria-labelledby="dashboard-funnel">
          <div className="panel-heading">
            <div>
              <h2 id="dashboard-funnel">Call for proposals</h2>
              <p>Every proposal by status. Each row opens the abstracts table with that filter already applied.</p>
            </div>
            <Link className="ghost-button" href="/admin/abstracts">All proposals</Link>
          </div>
          {!hasForms ? (
            <EmptyState icon={<FileText size={22} />} title="No CFP form yet">
              Nothing can be submitted until a form exists.{" "}
              <Link href="/admin/forms">Create your first form</Link> to open the call.
            </EmptyState>
          ) : !hasSubmissions ? (
            <EmptyState icon={<FileStack size={22} />} title="No proposals yet">
              {forms.published === 0 ? (
                <>
                  This event has {forms.total} form{forms.total === 1 ? "" : "s"}, none of them published — so
                  nobody can reach the call. <Link href="/admin/forms">Publish a form</Link> to start collecting.
                </>
              ) : (
                <>
                  The call is live. Proposals land here the moment a speaker submits —{" "}
                  <Link href="/admin/forms">share the public form</Link> to bring them in.
                </>
              )}
            </EmptyState>
          ) : (
            <ul className="dashboard-list">
              {funnel.segments.map((segment) => (
                <li key={segment.status}>
                  <Link href={segment.href}>
                    <Pill tone={segment.tone}>{segment.label}</Pill>
                    <strong>{segment.count}</strong>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ---- 2. Review progress ---- */}
        <section className="work-panel dashboard-panel" aria-labelledby="dashboard-review">
          <div className="panel-heading">
            <div>
              <h2 id="dashboard-review">Review progress</h2>
              <p>Assigned versus completed reviews in each round. Withdrawn proposals are excluded, as on the evaluation screen.</p>
            </div>
            <Link className="ghost-button" href="/admin/evaluations">Evaluation</Link>
          </div>
          {review.rounds.length === 0 ? (
            <EmptyState icon={<ClipboardCheck size={22} />} title="No review round yet">
              A round holds the rubric and the assignments.{" "}
              <Link href="/admin/evaluations">Create the first round</Link> to start scoring.
            </EmptyState>
          ) : (
            <ul className="dashboard-list">
              {review.rounds.map((round) => (
                <li key={round.id}>
                  <Link href={`/admin/evaluations?planId=${encodeURIComponent(round.id)}`}>
                    <span className="dashboard-row-label">{roundLabel(round)}</span>
                    <strong>
                      {round.assigned === 0 ? "Nothing assigned" : `${round.completed} / ${round.assigned}`}
                    </strong>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {review.truncatedRounds ? (
            <p className="dashboard-note">
              Only the first {OPERATOR_QUERY_LIMITS.dashboardPlans} rounds are shown; the totals
              above cover these rounds only. The full list lives in{" "}
              <Link href="/admin/evaluations">Evaluation</Link>.
            </p>
          ) : null}
          {funnel.segments.find((segment) => segment.status === "ACCEPTED")?.count ? (
            <p className="dashboard-note">
              {review.acceptedUnscheduled === 0 ? (
                <>Every accepted proposal is on the programme.</>
              ) : (
                <>
                  <strong>{review.acceptedUnscheduled}</strong> accepted proposal
                  {review.acceptedUnscheduled === 1 ? " is" : "s are"} not on the programme yet —{" "}
                  <Link href="/admin/agenda">place them in the agenda builder</Link>.
                </>
              )}
            </p>
          ) : null}
        </section>

        {/* ---- 3. Programme health ---- */}
        <section className="work-panel dashboard-panel" aria-labelledby="dashboard-programme">
          <div className="panel-heading">
            <div>
              <h2 id="dashboard-programme">Programme</h2>
              <p>Talks, placement and publication. &ldquo;Scheduled&rdquo; means the talk holds a slot.</p>
            </div>
            <Link className="ghost-button" href="/admin/agenda">Agenda builder</Link>
          </div>
          {programme.sessions === 0 ? (
            <EmptyState icon={<CalendarDays size={22} />} title="No talks yet">
              Accepting a proposal creates its talk, and the{" "}
              <Link href="/admin/agenda">agenda builder</Link> places it in a room.
            </EmptyState>
          ) : (
            <>
              <ul className="dashboard-list">
                <li>
                  <Link href="/admin/agenda">
                    <span className="dashboard-row-label">Scheduled</span>
                    <strong>
                      {boundedCount(programme.scheduled, programme.truncated)} / {boundedCount(programme.sessions, programme.truncated)}
                    </strong>
                  </Link>
                </li>
                <li>
                  <Link href="/admin/agenda">
                    <span className="dashboard-row-label">Not yet placed</span>
                    <strong>{boundedCount(programme.unscheduled, programme.truncated)}</strong>
                  </Link>
                </li>
                <li>
                  <Link href="/admin/agenda">
                    <span className="dashboard-row-label">Published to the public programme</span>
                    <strong>
                      {boundedCount(programme.published, programme.truncated)} / {boundedCount(programme.sessions, programme.truncated)}
                    </strong>
                  </Link>
                </li>
                <li>
                  <Link href="/admin/settings">
                    <span className="dashboard-row-label">Rooms in use</span>
                    <strong>{programme.roomsInUse} / {programme.roomsTotal}</strong>
                  </Link>
                </li>
              </ul>
              <p className="dashboard-note">
                {programme.conflicts === 0 ? (
                  <>No scheduling conflicts detected.</>
                ) : (
                  <>
                    <AlertTriangle size={14} aria-hidden="true" />{" "}
                    <strong>{boundedCountLabel(programme.conflicts, programme.truncated, "scheduling conflict")}</strong>{" "}
                    detected — <Link href="/admin/agenda">review them in the agenda builder</Link>.
                  </>
                )}
              </p>
              {programme.truncated ? (
                <p className="hint dashboard-note" role="status">
                  This event holds more talks than one read loads, so every programme figure above is a floor and
                  conflicts among the talks that were not loaded could not be detected.
                </p>
              ) : null}
            </>
          )}
        </section>

        {/* ---- 4. Speaker onboarding ---- */}
        <section className="work-panel dashboard-panel" aria-labelledby="dashboard-speakers">
          <div className="panel-heading">
            <div>
              <h2 id="dashboard-speakers">Speakers</h2>
              <p>Onboarding is measured over the confirmed-session cohort, exactly as on the roster.</p>
            </div>
            <Link className="ghost-button" href="/admin/speakers">Speaker onboarding</Link>
          </div>
          {speakers.total === 0 ? (
            <EmptyState icon={<UserCheck size={22} />} title="No speakers yet">
              Accepting a proposal names its speakers, or{" "}
              <Link href="/admin/speakers">add one to the roster</Link> before the call closes.
            </EmptyState>
          ) : (
            <ul className="dashboard-list">
              <li>
                <Link href="/admin/speakers">
                  <span className="dashboard-row-label">Speakers</span>
                  <strong>{speakers.total}</strong>
                </Link>
              </li>
              <li>
                <Link href="/admin/speakers?filter=incomplete-onboarding">
                  <span className="dashboard-row-label">Fully onboarded</span>
                  <strong>{speakers.onboardingComplete} / {speakers.confirmed}</strong>
                </Link>
              </li>
              <li>
                <Link href="/admin/speakers?filter=incomplete-onboarding">
                  <span className="dashboard-row-label">Required tasks open</span>
                  <strong>{speakers.requiredOutstanding}</strong>
                </Link>
              </li>
              <li>
                <Link href="/admin/speakers?filter=incomplete-onboarding">
                  <span className="dashboard-row-label">Speakers overdue</span>
                  <strong>{speakers.overdue}</strong>
                </Link>
              </li>
            </ul>
          )}
          {speakers.total > 0 && speakers.awaitingSession > 0 ? (
            <p className="dashboard-note">
              <strong>{speakers.awaitingSession}</strong> named speaker
              {speakers.awaitingSession === 1 ? " is" : "s are"} not on a session yet, so they are outside the
              onboarding figures above.
            </p>
          ) : null}
          {speakers.truncated ? (
            <p className="hint dashboard-note" role="status">
              This event exceeds the roster&rsquo;s bounded read, so the speaker figures above are floors.
            </p>
          ) : null}
        </section>
      </div>

      {/* ---- 5. Recent activity ---- */}
      <div className="dashboard-grid">
        <ActivityPanel
          headingId="dashboard-recent-submissions"
          title="Latest submissions"
          description={`The ${DASHBOARD_ACTIVITY_LABEL} most recent proposals to arrive. Each opens in the abstracts drawer.`}
          emptyTitle="Nothing submitted yet"
          emptyBody={
            <>
              Submissions appear here as they arrive.{" "}
              <Link href="/admin/forms">Check the call is published</Link>.
            </>
          }
          rows={recentSubmissions}
          timezone={view.timezone}
        />
        <ActivityPanel
          headingId="dashboard-recent-decisions"
          title="Latest decisions"
          description={`The ${DASHBOARD_ACTIVITY_LABEL} most recent accept, maybe or decline. A speaker's own withdrawal is not a decision and is not listed.`}
          emptyTitle="No decisions yet"
          emptyBody={
            <>
              Decisions are recorded from the abstracts drawer.{" "}
              <Link href="/admin/abstracts">Open the proposals</Link> to start deciding.
            </>
          }
          rows={recentDecisions}
          timezone={view.timezone}
        />
      </div>
    </section>
  );
}

const DASHBOARD_ACTIVITY_LABEL = "five";

function ActivityPanel({
  headingId,
  title,
  description,
  emptyTitle,
  emptyBody,
  rows,
  timezone,
}: {
  headingId: string;
  title: string;
  description: string;
  emptyTitle: string;
  emptyBody: React.ReactNode;
  rows: {
    id: string;
    title: string;
    status: keyof typeof ABSTRACT_STATUS_META;
    at: string;
    speakerName: string | null;
    href: string;
  }[];
  timezone: string;
}) {
  return (
    <section className="work-panel dashboard-panel" aria-labelledby={headingId}>
      <div className="panel-heading">
        <div>
          <h2 id={headingId}>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={<FileStack size={22} />} title={emptyTitle}>{emptyBody}</EmptyState>
      ) : (
        <ul className="dashboard-activity">
          {rows.map((row) => (
            <li key={row.id}>
              <Link href={row.href}>
                <span className="dashboard-activity-title">{row.title}</span>
                <span className="dashboard-activity-meta">
                  <Pill tone={ABSTRACT_STATUS_META[row.status].tone}>
                    {ABSTRACT_STATUS_META[row.status].label}
                  </Pill>
                  <span>{row.speakerName ?? "No speaker named"}</span>
                  <span>{formatEventDateTime(row.at, timezone)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
