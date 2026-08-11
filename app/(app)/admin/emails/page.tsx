import Link from "next/link";
import { MailCheck, Search } from "lucide-react";
import "@/components/feature.css";
import { EmptyState, PageHeader, Pill } from "@/components/ui";
import {
  EMAIL_HISTORY_PARAMS,
  EMAIL_HISTORY_PATH,
  EMAIL_RECIPIENT_SEARCH_MAX_LENGTH,
  EMAIL_STATUS_ALL,
  EMAIL_STATUS_FILTERS,
  emailHistoryEmptyState,
  emailHistoryIsFiltered,
  emailHistoryPageHref,
  emailHistoryRangeLabel,
  emailHistoryStatusHref,
} from "@/lib/comms/email-history";
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
 *
 * The status chips, the template select, the recipient search and the pager are
 * all GET parameters resolved server-side, exactly like the speaker roster: the
 * whole surface works with JavaScript disabled, every narrowed view is a
 * shareable URL, and no control here makes a client fetch. Because the filters
 * are applied by the database rather than to an already-read page, "Failed"
 * means failed in this event's log — not failed among the newest rows.
 */
export default async function AdminEmailsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const history = await getEmailHistory(params);
  const query = history.query;
  const filtered = emailHistoryIsFiltered(query);
  const empty = emailHistoryEmptyState(query);
  const when = (value: string | null) => formatEventDateTime(value, history.timezone);

  return (
    <section className="page-stack">
      <PageHeader
        eyebrow="Operations"
        title="Email history"
        description="Every message this event has attempted to send — reminders, decision notices, submission receipts, and reviewer invites — with what actually happened to each one."
      />

      {/*
        Every number here — the four metrics and the line below them — is counted
        from the same single query, so they can never disagree with each other or
        with the rows in the table. They describe this page of this filtered
        view, which is what their labels say; the panel still claims no
        event-wide total, because it never reads one.
      */}
      <div className="metric-grid">
        <div className="metric"><span>On this page</span><strong>{history.shown}</strong></div>
        <div className="metric"><span>Delivered</span><strong>{history.shownDelivered}</strong></div>
        <div className="metric"><span>Not delivered</span><strong>{history.shownUndelivered}</strong></div>
        <div className="metric"><span>Failed</span><strong>{history.shownFailed}</strong></div>
      </div>

      <p className="hint" role="status">
        {emailHistoryRangeLabel(history)}
        {filtered ? " These counts cover the emails matching the current filters only." : ""}
      </p>

      <div className="card">
        <div className="table-toolbar roster-toolbar">
          {/* A real GET form, like the speaker roster: the page already reads
              `?q=` and `?template=` server-side, so search and the template
              filter work with JavaScript disabled and every narrowed log is a
              shareable URL. The active status chip rides along in a hidden
              field, or submitting would silently drop it — and `page` is
              deliberately absent, because a new search starts at its own first
              page rather than page 7 of the previous one. */}
          <form className="roster-search-form" method="get" action={EMAIL_HISTORY_PATH} role="search">
            {query.status === EMAIL_STATUS_ALL ? null : (
              <input type="hidden" name={EMAIL_HISTORY_PARAMS.status} value={query.status} />
            )}
            <label className="speaker-search roster-search">
              <span className="sr-only">Search dispatches by recipient address</span>
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                name={EMAIL_HISTORY_PARAMS.query}
                autoComplete="off"
                defaultValue={query.query}
                maxLength={EMAIL_RECIPIENT_SEARCH_MAX_LENGTH}
                placeholder="Search recipients…"
              />
            </label>
            <label className="email-template-filter">
              <span className="sr-only">Filter by email template</span>
              <select name={EMAIL_HISTORY_PARAMS.template} defaultValue={query.template ?? ""}>
                <option value="">Every template</option>
                {history.templateKeys.map((key) => (
                  <option key={key} value={key}>{key}</option>
                ))}
              </select>
            </label>
            <button className="ghost-button" type="submit">Filter</button>
            {filtered ? (
              <Link className="ghost-button" href={EMAIL_HISTORY_PATH}>Clear</Link>
            ) : null}
          </form>

          {/* Deliberately without counts. The roster counts its chips from rows
              it already loaded; these filters run in the database, so a count
              per chip would be four more queries against four more snapshots —
              numbers that could disagree with the rows underneath them. */}
          <div className="row wrap" role="group" aria-label="Filter emails by delivery status">
            {EMAIL_STATUS_FILTERS.map((option) => {
              const active = query.status === option.value;
              return (
                // Links, not toggles: `aria-pressed` is not allowed on an anchor
                // (axe: aria-allowed-attr), so the active chip uses aria-current.
                <Link
                  aria-current={active ? "page" : undefined}
                  className={active ? "ghost-button active" : "ghost-button"}
                  href={emailHistoryStatusHref(query, option.value)}
                  key={option.value}
                >
                  {option.label}
                </Link>
              );
            })}
          </div>
        </div>

        {history.templatesTruncated ? (
          <p className="hint" role="status">
            This event has more email templates than the filter above can list. Some templates are missing
            from the select — the log itself is unaffected.
          </p>
        ) : null}

        {history.entries.length === 0 ? (
          <EmptyState icon={<MailCheck size={20} aria-hidden="true" />} title={empty.title}>
            {empty.body}
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

        {/* Both links carry every active filter, so paging never widens or
            narrows the set being paged through. Only the directions that were
            actually observed are offered: "older" comes from the page-plus-one
            probe, never from a total this page never read. */}
        {history.hasPrevious || history.hasMore ? (
          <nav className="table-pager" aria-label="Email history pages">
            {history.hasPrevious ? (
              <Link className="ghost-button" rel="prev" href={emailHistoryPageHref(query, query.page - 1)}>
                Newer emails
              </Link>
            ) : <span />}
            {history.hasMore ? (
              <Link className="ghost-button" rel="next" href={emailHistoryPageHref(query, query.page + 1)}>
                Older emails
              </Link>
            ) : <span />}
          </nav>
        ) : null}
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
        <p className="hint">
          Filters, search and paging run against the whole log for this event, not just the rows on
          screen — a status chip narrows every recorded email, not the newest page of them. The panel
          still states no lifetime total: it reads one page at a time and says only what that page
          showed.
        </p>
      </div>
    </section>
  );
}
