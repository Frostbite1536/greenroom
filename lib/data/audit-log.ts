/**
 * Server-only projection of one event's change history for `/admin/history`.
 *
 * Shaped like `lib/data/event-team.ts`: a typed Prisma seam here, with the rules
 * that can be reasoned about without a database — the diff shape, its rendering,
 * and the vocabulary — living in `lib/services/audit-log.ts`, where tests
 * exercise them directly.
 *
 * Scope rules, all load-bearing:
 * - It is keyed on ONE event id, which the page takes from the signed session.
 *   It cannot be pointed at another event's history, and there is no id, filter,
 *   or offset a caller supplies.
 * - It exposes only what the table renders: the actor's name and email, the
 *   entity, the action, the changed fields, and the timestamp. Nothing joins back
 *   to the changed record, so listing a change here reveals no more of the
 *   underlying row than the diff already stored.
 * - Bounded newest-first with an honest truncation notice rather than a refusal
 *   (`OPERATOR_QUERY_LIMITS.adminAuditLogPage`). This table only grows, so
 *   running past one page is the normal state of a live event, not an error —
 *   the same reasoning as the email log and the API-credential panel.
 * - A deleted account's rows survive with `actorUserId` null (SetNull), so the
 *   projection must render an absent actor rather than assume one.
 *
 * The read is `findMany` only. Nothing here — and nothing anywhere else —
 * updates or deletes an audit row.
 */
import { prisma } from "@/lib/prisma";
import { OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import {
  parseAuditChanges,
  summarizeAuditChanges,
  type AuditChangeSummary,
} from "@/lib/services/audit-log";

/** Newest-first page size for the history table. */
export const AUDIT_LOG_PAGE_TAKE = OPERATOR_QUERY_LIMITS.adminAuditLogPage;

export type AuditLogRow = {
  id: string;
  /** Stored strings, deliberately not narrowed: an unrecognized value still renders. */
  entityType: string;
  entityId: string;
  action: string;
  /** Rendered, ordered field changes — never the raw JSON. */
  changes: AuditChangeSummary[];
  createdAt: Date;
  /** Null once the account behind the change is deleted. */
  actor: { name: string; email: string } | null;
};

export type AuditLogView = {
  entries: AuditLogRow[];
  /** True when the bounded read was cut, so the page is a floor, not the whole history. */
  truncated: boolean;
};

export async function readAuditLog(eventId: string): Promise<AuditLogView> {
  const rows = await prisma.auditLogEntry.findMany({
    where: { eventId },
    // Newest first, with `id` breaking ties so two rows written in the same
    // transaction — and therefore holding the same `createdAt` default — keep a
    // stable order between renders instead of swapping places.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: AUDIT_LOG_PAGE_TAKE + 1,
    select: {
      id: true,
      entityType: true,
      entityId: true,
      action: true,
      changes: true,
      createdAt: true,
      actor: { select: { name: true, email: true } },
    },
  });

  return {
    truncated: rows.length > AUDIT_LOG_PAGE_TAKE,
    entries: rows.slice(0, AUDIT_LOG_PAGE_TAKE).map((row): AuditLogRow => ({
      id: row.id,
      entityType: row.entityType,
      entityId: row.entityId,
      action: row.action,
      // Parsed defensively: a malformed diff renders as no field changes rather
      // than throwing out the page an auditor opened to investigate.
      changes: summarizeAuditChanges(parseAuditChanges(row.changes)),
      createdAt: row.createdAt,
      actor: row.actor,
    })),
  };
}
