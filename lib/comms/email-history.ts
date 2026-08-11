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
 *
 * The panel is now filtered, searched and paged (EML-01). All four narrowings
 * are GET parameters resolved into one `where` here and applied by the database,
 * not by slicing an already-capped page: a log that only grows would otherwise
 * let "Failed" mean "failed among the newest 100", which is a different claim
 * from the one the chip makes. Everything in this module stays a pure function
 * of its inputs so the composition is unit-tested without a database.
 */

// ---- Delivery-status vocabulary -------------------------------------------

/**
 * Every status the product can write to `EmailDispatch.status`: the three
 * `DeliveryMode` outcomes in `lib/comms/send.ts` plus the `queued` row default
 * the schema stamps before an attempt reports back.
 *
 * The column is a `String`, not an enum, so this list is a code contract rather
 * than a schema-enforced one — `email-history.source.test.ts` pins it against
 * `send.ts` and `schema.prisma` so a new outcome cannot be sent without gaining
 * a filter chip here. A row carrying anything else is still rendered (under the
 * unfiltered chip, with an honest "unrecognised" label); it is simply not
 * reachable by a status filter, because a filter is an equality test and there
 * is no name to test against.
 */
export const EMAIL_DISPATCH_STATUSES = ["sent", "mocked", "failed", "queued"] as const;

export type EmailDispatchStatus = (typeof EMAIL_DISPATCH_STATUSES)[number];

export type EmailDispatchTone = "good" | "warn" | "bad" | "neutral";

const NO_RECORDED_REASON = "The provider rejected this message and recorded no reason.";

type EmailDispatchStatusMeta = {
  /** The row label. Long enough to be unambiguous inside the table. */
  label: string;
  /** The filter chip's label. Shorter, and never a claim the row label denies. */
  chipLabel: string;
  tone: EmailDispatchTone;
  /** The default outcome sentence for this status. */
  detail: string;
  /** True only when a provider accepted the message. */
  delivered: boolean;
  /** `failed` is the only status whose row carries its own stored reason. */
  usesStoredError?: true;
  /** Empty-state heading when this chip is pressed and nothing matches. */
  emptyTitle: string;
};

/**
 * One vocabulary for a dispatch status, so the pill in the table, the chip that
 * filters on it, and the empty state that explains an absence cannot drift into
 * describing the same stored value three different ways.
 *
 * `mocked` is the trap this exists for: those rows carry a `sentAt` and a
 * `mock:` provider handle, so anything that renders a timestamp as "delivered"
 * would report a demo-mode run as real mail. Only `sent` is delivery, and the
 * chip label says "Mocked" rather than anything a reader could hear as sent.
 */
export const EMAIL_DISPATCH_STATUS_META = {
  sent: {
    label: "Delivered",
    chipLabel: "Delivered",
    tone: "good",
    detail: "The email provider accepted this message.",
    delivered: true,
    emptyTitle: "No delivered emails",
  },
  mocked: {
    label: "Mocked — not delivered",
    chipLabel: "Mocked",
    tone: "warn",
    detail:
      "Recorded only. This deployment is in mock mode or has no email provider configured, so nothing was sent.",
    delivered: false,
    emptyTitle: "No mocked attempts",
  },
  failed: {
    label: "Failed",
    chipLabel: "Failed",
    tone: "bad",
    detail: NO_RECORDED_REASON,
    delivered: false,
    usesStoredError: true,
    emptyTitle: "No failed dispatches",
  },
  queued: {
    label: "No result recorded",
    chipLabel: "No result",
    tone: "neutral",
    detail:
      "The attempt was logged but never reported an outcome — the send did not finish. Treat it as undelivered.",
    delivered: false,
    emptyTitle: "No unfinished attempts",
  },
} satisfies Record<EmailDispatchStatus, EmailDispatchStatusMeta>;

export function isEmailDispatchStatus(value: string): value is EmailDispatchStatus {
  return (EMAIL_DISPATCH_STATUSES as readonly string[]).includes(value);
}

// ---- Filter, search and page vocabulary -----------------------------------

/** The "no filter" chip. Not an `EmailDispatchStatus`, so it is named apart. */
export const EMAIL_STATUS_ALL = "all";

export type EmailStatusFilter = EmailDispatchStatus | typeof EMAIL_STATUS_ALL;

/**
 * The status chips, in the order they render. Derived from the status list
 * rather than restated, so the chip↔status bijection holds by construction: a
 * status cannot be added without gaining a chip, and no chip can name a status
 * that does not exist. `all` is the deliberate exception.
 */
export const EMAIL_STATUS_FILTERS: { value: EmailStatusFilter; label: string }[] = [
  { value: EMAIL_STATUS_ALL, label: "All" },
  ...EMAIL_DISPATCH_STATUSES.map((status) => ({
    value: status as EmailStatusFilter,
    label: EMAIL_DISPATCH_STATUS_META[status].chipLabel,
  })),
];

/** The page this module builds URLs for. */
export const EMAIL_HISTORY_PATH = "/admin/emails";

/** The GET parameters the page reads. One name, read and written from here. */
export const EMAIL_HISTORY_PARAMS = {
  status: "status",
  template: "template",
  query: "q",
  page: "page",
} as const;

/**
 * Long enough for a full address, short enough that a hostile URL cannot push
 * an unbounded string into a `contains` predicate on every request.
 */
export const EMAIL_RECIPIENT_SEARCH_MAX_LENGTH = 120;

/** Rows per page. Bounded like every other operator read (INV-EVENT-001). */
export const EMAIL_HISTORY_PAGE_SIZE = OPERATOR_QUERY_LIMITS.adminEmailDispatchPage;

/** Page-plus-one: the extra row is the has-more signal, never rendered. */
export const EMAIL_HISTORY_PAGE_TAKE = EMAIL_HISTORY_PAGE_SIZE + 1;

/**
 * Upper bound on the page number a URL may name. `skip` is work the database
 * does before it returns anything, so an unbounded `?page=` is an unbounded
 * offset scan requested by a URL — bounded here rather than trusted.
 */
export const EMAIL_HISTORY_MAX_PAGE = 200;

/** One resolved view: what the URL asked for, after every bound is applied. */
export type EmailHistoryQuery = {
  status: EmailStatusFilter;
  /** A template key this event actually has, or null for every template. */
  template: string | null;
  /** Bounded recipient substring, or "" for no search. */
  query: string;
  /** 1-based, always within `[1, EMAIL_HISTORY_MAX_PAGE]`. */
  page: number;
};

/** The raw `searchParams` shape a Next.js page hands in. */
export type EmailHistorySearchParams = Partial<Record<string, string | string[] | undefined>>;

/**
 * Normalize `?status=`. Anything unrecognized — a made-up value, a repeated
 * parameter, a different casing — falls back to the unfiltered chip, matching
 * `parseAbstractStatusFilter`: guessing at a near-miss would show a different
 * set of emails than the URL names, and refusing the page over a stale link
 * would be worse than rendering the whole log.
 */
export function parseEmailStatusFilter(value: string | string[] | undefined): EmailStatusFilter {
  if (typeof value !== "string") return EMAIL_STATUS_ALL;
  const trimmed = value.trim();
  const chip = EMAIL_STATUS_FILTERS.find((candidate) => candidate.value === trimmed);
  return chip ? chip.value : EMAIL_STATUS_ALL;
}

/**
 * Normalize `?template=` against the keys this event actually has.
 *
 * Validating against the loaded list rather than accepting any string is what
 * keeps a filtered view honest: an unknown key would otherwise render an empty
 * table that looks like "this template sent nothing" when it names no template
 * at all.
 */
export function parseEmailTemplateFilter(
  value: string | string[] | undefined,
  templateKeys: readonly string[],
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return templateKeys.includes(trimmed) ? trimmed : null;
}

/** Normalize `?q=` into the search the page will both apply and echo back. */
export function parseEmailRecipientQuery(value: string | string[] | undefined): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, EMAIL_RECIPIENT_SEARCH_MAX_LENGTH);
}

/**
 * Normalize `?page=`. Only a plain run of digits is a page number: `-2`, `1.5`,
 * `1e9` and `０` are all the first page rather than an error, and anything past
 * the bound is clamped to it.
 */
export function parseEmailHistoryPage(value: string | string[] | undefined): number {
  if (typeof value !== "string") return 1;
  const trimmed = value.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return 1;
  const page = Number(trimmed);
  if (page < 1) return 1;
  return Math.min(page, EMAIL_HISTORY_MAX_PAGE);
}

/**
 * Clamp any page number into the bound, whatever produced it. `NaN` is the one
 * input with no position on the range, so it reads as the first page rather
 * than propagating through `Math.min` as `NaN` into a `skip`.
 */
export function clampEmailHistoryPage(page: number): number {
  if (Number.isNaN(page)) return 1;
  return Math.min(Math.max(Math.trunc(page), 1), EMAIL_HISTORY_MAX_PAGE);
}

/** Resolve a whole URL into the one bounded view the read and the UI share. */
export function parseEmailHistoryQuery(
  params: EmailHistorySearchParams,
  templateKeys: readonly string[],
): EmailHistoryQuery {
  return {
    status: parseEmailStatusFilter(params[EMAIL_HISTORY_PARAMS.status]),
    template: parseEmailTemplateFilter(params[EMAIL_HISTORY_PARAMS.template], templateKeys),
    query: parseEmailRecipientQuery(params[EMAIL_HISTORY_PARAMS.query]),
    page: parseEmailHistoryPage(params[EMAIL_HISTORY_PARAMS.page]),
  };
}

/** True when the URL narrows the log at all — the "Clear" affordance's test. */
export function emailHistoryIsFiltered(query: EmailHistoryQuery): boolean {
  return query.status !== EMAIL_STATUS_ALL || query.template !== null || query.query !== "";
}

/**
 * Event scoping for the dispatch log, plus whatever the URL narrowed it to.
 *
 * `EmailDispatch` carries no `eventId` of its own, so the scope must traverse
 * its required template parent — and the template filter rides on that same
 * traversal rather than adding a second one, so no narrowing can widen the
 * event scope. The recipient search is a Prisma `contains`, which is a bound
 * parameter and never string-concatenated SQL; the value is length-bounded by
 * `parseEmailRecipientQuery` before it reaches here.
 */
export function emailHistoryWhere(
  eventId: string,
  query?: EmailHistoryQuery,
): Prisma.EmailDispatchWhereInput {
  const template: Prisma.EmailTemplateWhereInput = { eventId };
  if (query?.template) template.key = query.template;
  const where: Prisma.EmailDispatchWhereInput = { template };
  if (query && query.status !== EMAIL_STATUS_ALL) where.status = query.status;
  if (query?.query) where.recipient = { contains: query.query, mode: "insensitive" };
  return where;
}

/** Rows to skip for a page, with the page bound re-applied defensively. */
export function emailHistorySkip(page: number): number {
  return (clampEmailHistoryPage(page) - 1) * EMAIL_HISTORY_PAGE_SIZE;
}

/**
 * The panel URL for one filter/search/page combination.
 *
 * Every narrowing lives in the URL, so each control has to carry the others:
 * a chip that dropped the search, or a next-page link that dropped the chip,
 * would silently show a different set of emails than the one the operator was
 * looking at. Defaults are omitted rather than written as no-op parameters.
 */
export function emailHistoryHref(query: EmailHistoryQuery): string {
  const params = new URLSearchParams();
  if (query.status !== EMAIL_STATUS_ALL) params.set(EMAIL_HISTORY_PARAMS.status, query.status);
  if (query.template !== null) params.set(EMAIL_HISTORY_PARAMS.template, query.template);
  if (query.query !== "") params.set(EMAIL_HISTORY_PARAMS.query, query.query);
  const page = clampEmailHistoryPage(query.page);
  if (page > 1) params.set(EMAIL_HISTORY_PARAMS.page, String(page));
  const search = params.toString();
  return search === "" ? EMAIL_HISTORY_PATH : `${EMAIL_HISTORY_PATH}?${search}`;
}

/**
 * A chip's link. Changing which statuses are shown returns to the first page:
 * page 7 of one filter is not page 7 of another, and keeping the number would
 * land an operator on an empty page of a set they just narrowed.
 */
export function emailHistoryStatusHref(query: EmailHistoryQuery, status: EmailStatusFilter): string {
  return emailHistoryHref({ ...query, status, page: 1 });
}

/** A pager link. Same filters, different page — never the other way round. */
export function emailHistoryPageHref(query: EmailHistoryQuery, page: number): string {
  return emailHistoryHref({ ...query, page });
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

export type EmailDispatchStatusView = {
  label: string;
  tone: EmailDispatchTone;
  /** One sentence an operator can act on. Never claims an unverified send. */
  detail: string;
  /** True only when a provider accepted the message. */
  delivered: boolean;
};

/**
 * Turn a stored status into wording that cannot overstate what happened.
 *
 * Reads `EMAIL_DISPATCH_STATUS_META` rather than restating it, so the pill in
 * the table and the chip that filters on it are the same words about the same
 * stored value. A status outside the list is described honestly instead of
 * being folded into a neighbouring one.
 */
export function describeEmailDispatchStatus(
  status: string,
  error: string | null,
): EmailDispatchStatusView {
  if (!isEmailDispatchStatus(status)) {
    return {
      label: `Unrecognised status: ${status}`,
      tone: "neutral",
      detail:
        "This row carries a status this panel does not know how to interpret. Treat it as undelivered.",
      delivered: false,
    };
  }
  const meta: EmailDispatchStatusMeta = EMAIL_DISPATCH_STATUS_META[status];
  const reason = error?.trim() ? error.trim() : null;
  return {
    label: meta.label,
    tone: meta.tone,
    // Only a failure has a row-specific reason to surface; every other status
    // says the same sentence about every row that carries it.
    detail: meta.usesStoredError && reason ? reason : meta.detail,
    delivered: meta.delivered,
  };
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

export type EmailHistoryPage = {
  entries: EmailHistoryEntry[];
  /** Rows on this page. Never spoken of as an event-wide or filtered total. */
  shown: number;
  pageSize: number;
  /** 1-based page number, already bounded. */
  page: number;
  /** True when the page-plus-one probe found another row after this page. */
  hasMore: boolean;
  hasPrevious: boolean;
  /** 1-based position of the first and last row shown, 0 when the page is empty. */
  firstShown: number;
  lastShown: number;
  /** Counts across `entries` only — never presented as event-wide totals. */
  shownDelivered: number;
  shownUndelivered: number;
  shownFailed: number;
};

/**
 * Fold a page-plus-one query into an honest page.
 *
 * Everything the panel states comes from this one query. An earlier draft paired
 * it with a separate `count()` to show an exact event-wide total, but the two
 * statements read different snapshots: a dispatch inserted between them let the
 * page print a total that disagreed with the rows underneath it. Rather than
 * narrow that window — a `RepeatableRead` transaction would — the total is gone,
 * and pagination did not bring it back: there is a "next page" claim, sourced
 * from the extra fetched row, and no page count, because a page count needs a
 * total this module refuses to invent.
 *
 * `firstShown`/`lastShown` are positions within the *current filters*, which is
 * why the copy says "in this view" rather than naming the log.
 */
export function toEmailHistoryPage(
  rows: readonly EmailDispatchRow[],
  page: number,
): EmailHistoryPage {
  const safePage = clampEmailHistoryPage(page);
  const entries = rows.slice(0, EMAIL_HISTORY_PAGE_SIZE).map(toEmailHistoryEntry);
  const skip = emailHistorySkip(safePage);
  return {
    entries,
    shown: entries.length,
    pageSize: EMAIL_HISTORY_PAGE_SIZE,
    page: safePage,
    hasMore: rows.length > EMAIL_HISTORY_PAGE_SIZE,
    hasPrevious: safePage > 1,
    firstShown: entries.length === 0 ? 0 : skip + 1,
    lastShown: entries.length === 0 ? 0 : skip + entries.length,
    shownDelivered: entries.filter((entry) => entry.delivered).length,
    shownUndelivered: entries.filter((entry) => !entry.delivered).length,
    shownFailed: entries.filter((entry) => entry.status === "failed").length,
  };
}

/**
 * The "showing X–Y" line. States a position inside the current view and a next
 * page when one was observed; it never states how many emails exist, because
 * this page never counted them.
 */
export function emailHistoryRangeLabel(page: EmailHistoryPage): string {
  if (page.shown === 0) return "No emails in this view.";
  const range =
    page.firstShown === page.lastShown
      ? `Showing email ${page.firstShown}`
      : `Showing emails ${page.firstShown}–${page.lastShown}`;
  return page.hasMore
    ? `${range} of this view, newest first — older ones continue on the next page.`
    : `${range} of this view, newest first — the oldest email in this view is on this page.`;
}

function joinNarrowings(parts: readonly string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * Copy for a view with nothing in it, said in terms of what was actually asked.
 *
 * The distinction this exists for: "no failed dispatches" and "no emails yet"
 * are different facts, and the second one is not something a filtered query can
 * establish. Only the unfiltered first page may claim the log itself is empty;
 * every other empty view says what it narrowed to and offers to widen.
 */
export function emailHistoryEmptyState(query: EmailHistoryQuery): { title: string; body: string } {
  if (query.page > 1) {
    return {
      title: "Nothing on this page",
      body: "This view has fewer emails than this page would start at. Go back a page to see the newest ones.",
    };
  }
  const narrowings: string[] = [];
  if (query.template !== null) narrowings.push(`the “${query.template}” template`);
  if (query.query !== "") narrowings.push(`recipients containing “${query.query}”`);

  if (query.status === EMAIL_STATUS_ALL && narrowings.length === 0) {
    return {
      title: "No emails sent yet",
      body: "Send a speaker reminder or publish a decision from Operations — every attempt, delivered or not, is recorded here.",
    };
  }
  const title =
    query.status === EMAIL_STATUS_ALL
      ? "No emails match these filters"
      : EMAIL_DISPATCH_STATUS_META[query.status].emptyTitle;
  const body =
    narrowings.length === 0
      ? "No email in this event's log carries that status. That says nothing about the other statuses — clear the filter to see them."
      : `Nothing in this view matches ${joinNarrowings(narrowings)}. Clear a filter to widen it.`;
  return { title, body };
}
