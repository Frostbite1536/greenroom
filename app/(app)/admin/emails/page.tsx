import { MailCheck } from "lucide-react";
import "@/components/feature.css";
import { EmptyState, PageHeader, Pill } from "@/components/ui";
import { getEmailHistory } from "@/lib/data/reads";
import { formatEventDateTime } from "@/lib/tz";

export const metadata = { title: "Email history" };
export const dynamic = "force-dynamic";

/**
 * `/admin/emails` — the reader for the `EmailDispatch` log.
 *
 * Every email Greenroom sends already wrote a row here; until now nothing
 * displayed them, so "the acceptance email went out" was an unevidenced claim
 * and a bulk reminder's failure count named neither recipient nor reason.
 *
 * The page renders only what the schema stores. Two things it deliberately does
 * not do: it never calls a mocked attempt delivered (those rows carry a
 * `sentAt` like real sends, so the status column is the only delivery claim),
 * and it never presents the template subject as the exact rendered subject —
 * dispatches do not store one. Authorization is the shared admin page guard in
 * `getEmailHistory`, which redirects non-admins the same way the other admin
 * reads do; this page adds no privilege of its own.
 */
export default async function AdminEmailsPage() {
  const history = await getEmailHistory();
  const when = (value: string | null) => formatEventDateTime(value, history.timezone);

  return (
    <section className="page-stack">
      <PageHeader
        eyebrow="Operations"
        title="Email history"
        description="Every message this event has attempted to send — reminders, decision notices, submission receipts, and reviewer invites — with what actually happened to each one."
      />

      {/*
        Every number on this page — the four metrics and the line below them —
        is counted from the same single query, so they can never disagree with
        each other or with the rows in the table. When the log is truncated the
        page says so and claims no event-wide total, rather than pairing this
        read with a separate count that would observe a different snapshot.
      */}
      <div className="metric-grid">
        <div className="metric"><span>{history.truncated ? "Shown" : "Recorded emails"}</span><strong>{history.shown}</strong></div>
        <div className="metric"><span>Delivered</span><strong>{history.shownDelivered}</strong></div>
        <div className="metric"><span>Not delivered</span><strong>{history.shownUndelivered}</strong></div>
        <div className="metric"><span>Failed</span><strong>{history.shownFailed}</strong></div>
      </div>

      <p className="hint" role="status">
        {history.shown === 0
          ? "No emails have been attempted for this event yet."
          : history.truncated
            ? `Showing the ${history.cap} most recent emails — more exist beyond this page. The counts above describe these ${history.cap} rows only, not the whole event.`
            : `Showing all ${history.shown} recorded ${history.shown === 1 ? "email" : "emails"} for this event, newest first.`}
      </p>

      <div className="card">
        {history.entries.length === 0 ? (
          <EmptyState icon={<MailCheck size={20} aria-hidden="true" />} title="No emails sent yet">
            Send a speaker reminder or publish a decision from Operations — every attempt, delivered or
            not, is recorded here.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <caption className="sr-only">
                Email dispatches for this event, newest first, with delivery outcome
              </caption>
              <thead>
                <tr>
                  <th scope="col">Logged</th>
                  <th scope="col">Recipient</th>
                  <th scope="col">Template</th>
                  <th scope="col">Status</th>
                  <th scope="col">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {history.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <div className="cell-title">{when(entry.loggedAt) ?? entry.loggedAt}</div>
                      <div className="cell-sub">
                        {entry.attemptCompletedAt
                          ? `Attempt finished ${when(entry.attemptCompletedAt) ?? entry.attemptCompletedAt}`
                          : "No attempt outcome recorded"}
                      </div>
                    </td>
                    <td>
                      <div className="cell-title">{entry.recipient}</div>
                      <div className="cell-sub">
                        {entry.sentBy ? `Triggered by ${entry.sentBy}` : "Automatic"}
                      </div>
                    </td>
                    <td>
                      <div className="cell-title">{entry.templateKey}</div>
                      <div className="cell-sub">
                        {entry.templateSubject}
                        {entry.trigger ? ` · ${entry.trigger}` : ""}
                      </div>
                    </td>
                    <td><Pill tone={entry.statusTone}>{entry.statusLabel}</Pill></td>
                    <td>{entry.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 18 }}>
        <h2 style={{ margin: "0 0 6px", fontSize: 15 }}>Reading this log</h2>
        <p className="hint">
          <strong>Delivered</strong> means the email provider accepted the message.{" "}
          <strong>Mocked</strong> rows were recorded but never handed to a provider — this deployment
          runs in mock mode or has no email credentials configured. Mocked attempts are stamped with a
          finish time exactly like real ones, so the status column, not the timestamp, is the only
          statement about delivery on this page.
        </p>
        <p className="hint">
          The template column is the template a send was logged against, together with that
          template&rsquo;s subject line. A dispatch does not store its own rendered subject, so for
          automatic receipts the delivered subject can differ from the one shown here.
        </p>
      </div>
    </section>
  );
}
