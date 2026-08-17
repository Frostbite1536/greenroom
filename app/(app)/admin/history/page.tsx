import { redirect } from "next/navigation";
import { History } from "lucide-react";
import "@/components/feature.css";
import { EmptyState, PageHeader, Pill } from "@/components/ui";
import { getApiContext } from "@/lib/api/context";
import { prisma } from "@/lib/prisma";
import { AUDIT_LOG_PAGE_TAKE, readAuditLog } from "@/lib/data/audit-log";
import {
  AUDIT_ACTION_LABELS,
  AUDIT_ENTITY_LABELS,
  formatAuditFieldName,
  type AuditAction,
  type AuditEntityType,
} from "@/lib/services/audit-log";
import { formatEventDateTime, timeZoneNote } from "@/lib/tz";

export const metadata = { title: "Change history" };
export const dynamic = "force-dynamic";

/**
 * Who changed what, and when (W24, the external audit's second finding).
 *
 * A pure server component. Every row is read once, server-side, by
 * `readAuditLog()`; nothing on this page is interactive, so there is no client
 * component here at all — and there is deliberately nothing to click that changes
 * anything, because an audit trail with a write surface is not an audit trail.
 *
 * Page-level auth redirects rather than throws, the same pattern every sibling
 * admin page uses. Reaching this page grants nothing on its own: the history is
 * scoped to the signed session's own event, and the write routes behind the
 * changes it lists re-read the caller's ADMIN row inside their own transactions.
 *
 * ADMIN-only, and not for the sake of the diffs alone. A change history is a
 * record of colleagues' actions — who edited whose bio, who reversed whose
 * decision — and that is an organizer's view, not a reviewer's or a speaker's.
 *
 * Newest first and bounded. This table only grows, so the page states that older
 * changes are not shown instead of pretending to be the whole history. Timestamps
 * are printed in the event's own timezone for the same reason the agenda is: a
 * remote organizer reading their browser's zone would place every change at the
 * wrong hour.
 */

/** Tone tracks what kind of act it was, not health: nothing here is a problem. */
const ACTION_TONE: Record<string, string> = {
  PUBLISH: "ok",
  UNPUBLISH: "warn",
  UNSCHEDULE: "warn",
  DECIDE: "info",
  SCHEDULE: "info",
  MOVE: "info",
  UPDATE: "neutral",
};

/** Stored strings are rendered through the labels when known, verbatim when not. */
const entityLabel = (entityType: string) =>
  AUDIT_ENTITY_LABELS[entityType as AuditEntityType] ?? entityType;
const actionLabel = (action: string) => AUDIT_ACTION_LABELS[action as AuditAction] ?? action;

export default async function AdminHistoryPage() {
  // Page-level auth: redirect rather than throw, matching the other admin pages.
  const ctx = await getApiContext();
  if (!ctx) redirect("/login");
  if (ctx.role !== "ADMIN") redirect("/portal");

  const [history, event] = await Promise.all([
    readAuditLog(ctx.eventId),
    prisma.event.findUnique({ where: { id: ctx.eventId }, select: { timezone: true } }),
  ]);
  // A missing timezone means the event id names no event; redirect rather than
  // print timestamps against a row that is not there.
  if (!event) redirect("/login");

  const { entries, truncated } = history;
  const clockNote = timeZoneNote(event.timezone, entries.map((entry) => entry.createdAt));

  return (
    <section className="page-stack" style={{ width: "min(1180px, 100%)" }}>
      <PageHeader
        eyebrow="Accountability"
        title="Change history"
        description="Every recorded change to this event's programme, newest first, with who made it and exactly which fields moved. Records are written in the same transaction as the change they describe, so nothing here can describe a change that did not happen."
      />

      <section className="work-panel" aria-labelledby="history-log">
        <div className="panel-heading">
          <div>
            <h2 id="history-log">Recorded changes</h2>
            <p>
              Speaker profile edits, publication changes, schedule placements and proposal decisions.
              Only the fields that actually changed are stored, so a save that changed nothing leaves
              no entry.
            </p>
            <p className="hint">{clockNote}.</p>
          </div>
        </div>

        {entries.length === 0 ? (
          <EmptyState icon={<History aria-hidden="true" size={22} />} title="No recorded changes yet">
            The next profile edit, publication change, schedule placement or decision on this event
            will appear here, attributed and timestamped.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <caption className="sr-only">
                Recorded changes to this event, newest first, with actor, record, action and changed fields
              </caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Who</th>
                  <th scope="col">What</th>
                  <th scope="col">Action</th>
                  <th scope="col">Changed fields</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <th scope="row">{formatEventDateTime(entry.createdAt, event.timezone)}</th>
                    <td>
                      {entry.actor ? (
                        <>
                          <div className="cell-title">{entry.actor.name}</div>
                          <div className="cell-sub">{entry.actor.email}</div>
                        </>
                      ) : (
                        // The row outlives the account on purpose (SetNull): a
                        // departed organizer cannot erase what they changed.
                        <span className="muted">A removed account</span>
                      )}
                    </td>
                    <td>
                      <div className="cell-title">{entityLabel(entry.entityType)}</div>
                      <div className="cell-sub">{entry.entityId}</div>
                    </td>
                    <td>
                      <Pill tone={ACTION_TONE[entry.action] ?? "neutral"}>
                        {actionLabel(entry.action)}
                      </Pill>
                    </td>
                    <td>
                      {entry.changes.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        // The proposal drawer's own field/value list, reused
                        // rather than restyled: same two-line shape, same rules.
                        <dl className="answer-list">
                          {entry.changes.map((change) => (
                            <div className="answer-item" key={change.field}>
                              <dt>{formatAuditFieldName(change.field)}</dt>
                              <dd>
                                {change.from} → {change.to}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {truncated ? (
          <p className="hint dashboard-note" role="status">
            Showing the latest {AUDIT_LOG_PAGE_TAKE} recorded changes. Older changes are still stored
            but are not shown on this page.
          </p>
        ) : null}
      </section>
    </section>
  );
}
