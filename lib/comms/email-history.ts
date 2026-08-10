import type { Prisma } from "@prisma/client";
import { OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";

/**
 * Read model behind `/admin/emails`.
 *
 * `lib/comms/send.ts` has written an `EmailDispatch` row for every email since
 * the audited send path landed, but nothing read them back: an operator could
 * trigger a decision mail, a reminder, or a reviewer invite and see no evidence
 * that anything happened, and a bulk reminder reporting "2 could not be
 * delivered" gave no way to find out which two or why. This module is the
 * projection and the vocabulary for that panel.
 *
 * Two honesty constraints shape everything below.
 *
 * 1. `EmailDispatch` has no `eventId`. It hangs off `EmailTemplate`, which does,
 *    so INV-EVENT-001 scoping runs through the template parent — never through
 *    a recipient or sender lookup, which would leak rows from other events that
 *    happen to share a person.
 * 2. `sentAt` is stamped for `mocked` attempts as well as real ones (see
 *    `dispatchEmail`), so a timestamp is not a delivery claim. `status` is the
 *    only field on the row that says whether a provider ever saw the message,
 *    and it is the only thing this module lets the UI phrase as delivery.
 */

export const EMAIL_HISTORY_CAP = OPERATOR_QUERY_LIMITS.adminEmailDispatches;

/** Cap-plus-one: the extra row is the truncation signal, never rendered. */
export const EMAIL_HISTORY_TAKE = EMAIL_HISTORY_CAP + 1;

/**
 * Event scoping for the dispatch log. `EmailDispatch` carries no `eventId` of
 * its own, so the filter must traverse its required template parent.
 */
export function emailHistoryWhere(eventId: string): Prisma.EmailDispatchWhereInput {
  return { template: { eventId } };
}

/**
 * Newest first, with `id` breaking equal-timestamp ties so a bulk send — which
 * writes many rows inside the same millisecond — has one stable order rather
 * than a page that reshuffles on every refresh.
 */
export const emailHistoryOrderBy = [
  { createdAt: "desc" },
  { id: "desc" },
] satisfies Prisma.EmailDispatchOrderByWithRelationInput[];

/**
 * Deliberately narrow. `providerId` and `variables` are never projected:
 * `variables` is an operator-supplied bag that a future template could be given
 * anything in, and `providerId` is a provider-side handle. Neither is needed to
 * answer "did this email go out, and if not why", which is the panel's whole
 * job. `htmlBody` is likewise excluded from the template selection — the log
 * shows what was attempted, not the rendered marketing body.
 */
export const EMAIL_INTENTIONALLY_UNPROJECTED_FIELDS = ["providerId", "variables"] as const;

export const emailHistorySelect = {
  id: true,
  recipient: true,
  status: true,
  error: true,
  createdAt: true,
  sentAt: true,
  template: { select: { key: true, subject: true, trigger: true } },
  sender: { select: { name: true } },
} satisfies Prisma.EmailDispatchSelect;

/** The shape `emailHistorySelect` returns, restated so tests need no database. */
export type EmailDispatchRow = {
  id: string;
  recipient: string;
  status: string;
  error: string | null;
  createdAt: Date;
  sentAt: Date | null;
  template: { key: string; subject: string; trigger: string | null };
  sender: { name: string } | null;
};

export type EmailDispatchTone = "good" | "warn" | "bad" | "neutral";

export type EmailDispatchStatusView = {
  label: string;
  tone: EmailDispatchTone;
  /** One sentence an operator can act on. Never claims an unverified send. */
  detail: string;
  /** True only when a provider accepted the message. */
  delivered: boolean;
};

const NO_RECORDED_REASON =
  "The provider rejected this message and recorded no reason.";

/**
 * Turn a stored status into wording that cannot overstate what happened.
 *
 * `mocked` is the trap this exists for: those rows carry a `sentAt` and a
 * `mock:` provider handle, so anything that renders a timestamp as "delivered"
 * would report a demo-mode run as real mail. Only `sent` is delivery.
 */
export function describeEmailDispatchStatus(
  status: string,
  error: string | null,
): EmailDispatchStatusView {
  const reason = error?.trim() ? error.trim() : null;
  switch (status) {
    case "sent":
      return {
        label: "Delivered",
        tone: "good",
        detail: "The email provider accepted this message.",
        delivered: true,
      };
    case "mocked":
      return {
        label: "Mocked — not delivered",
        tone: "warn",
        detail:
          "Recorded only. This deployment is in mock mode or has no email provider configured, so nothing was sent.",
        delivered: false,
      };
    case "failed":
      return {
        label: "Failed",
        tone: "bad",
        detail: reason ?? NO_RECORDED_REASON,
        delivered: false,
      };
    case "queued":
      return {
        label: "No result recorded",
        tone: "neutral",
        detail:
          "The attempt was logged but never reported an outcome — the send did not finish. Treat it as undelivered.",
        delivered: false,
      };
    default:
      return {
        label: `Unrecognised status: ${status}`,
        tone: "neutral",
        detail:
          "This row carries a status this panel does not know how to interpret. Treat it as undelivered.",
        delivered: false,
      };
  }
}

export type EmailHistoryEntry = {
  id: string;
  recipient: string;
  /** The template the send was logged against, not a rendered subject. */
  templateKey: string;
  templateSubject: string;
  trigger: string | null;
  /** Operator who triggered the send; automatic receipts have none. */
  sentBy: string | null;
  loggedAt: string;
  /** Set for mocked attempts too — see `describeEmailDispatchStatus`. */
  attemptCompletedAt: string | null;
  status: string;
  statusLabel: string;
  statusTone: EmailDispatchTone;
  outcome: string;
  delivered: boolean;
};

export function toEmailHistoryEntry(row: EmailDispatchRow): EmailHistoryEntry {
  const status = describeEmailDispatchStatus(row.status, row.error);
  return {
    id: row.id,
    recipient: row.recipient,
    templateKey: row.template.key,
    templateSubject: row.template.subject,
    trigger: row.template.trigger,
    sentBy: row.sender?.name ?? null,
    loggedAt: row.createdAt.toISOString(),
    attemptCompletedAt: row.sentAt?.toISOString() ?? null,
    status: row.status,
    statusLabel: status.label,
    statusTone: status.tone,
    outcome: status.detail,
    delivered: status.delivered,
  };
}

export type EmailHistory = {
  entries: EmailHistoryEntry[];
  /** Every dispatch this event has, including the ones beyond the cap. */
  total: number;
  shown: number;
  cap: number;
  truncated: boolean;
  /** Counts across `entries` only — never presented as event-wide totals. */
  shownDelivered: number;
  shownUndelivered: number;
  shownFailed: number;
};

/**
 * Fold a cap-plus-one query into an honest page.
 *
 * `truncated` comes from the extra row rather than from `total`, so a send that
 * lands between the page query and the count cannot make the panel claim
 * completeness it does not have.
 */
export function toEmailHistory(rows: readonly EmailDispatchRow[], total: number): EmailHistory {
  const entries = rows.slice(0, EMAIL_HISTORY_CAP).map(toEmailHistoryEntry);
  return {
    entries,
    total,
    shown: entries.length,
    cap: EMAIL_HISTORY_CAP,
    truncated: rows.length > EMAIL_HISTORY_CAP,
    shownDelivered: entries.filter((entry) => entry.delivered).length,
    shownUndelivered: entries.filter((entry) => !entry.delivered).length,
    shownFailed: entries.filter((entry) => entry.status === "failed").length,
  };
}
