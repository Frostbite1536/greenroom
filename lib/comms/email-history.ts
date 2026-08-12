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
  cursor: "cursor",
  direction: "dir",
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
 * Which way the current read walks away from its cursor. `older` is the
 * default: the panel opens at the newest email and pages backwards in time.
 */
export const EMAIL_HISTORY_DIRECTIONS = ["older", "newer"] as const;

export type EmailHistoryDirection = (typeof EMAIL_HISTORY_DIRECTIONS)[number];

/**
 * A position in the log, not an offset into it.
 *
 * `EmailDispatch` is append-mostly and its filtered sets change under a reader:
 * a dispatch inserted between two requests — or a `queued` row resolving into
 * `sent` while a status chip is pressed — shifts every subsequent offset by
 * one, so a numeric `skip` shows a row twice or never shows it at all. There is
 * no page number this page could offer that stays true for the length of an
 * operator reading it, so it offers none: each page is anchored to the last row
 * the operator actually saw, and an insert somewhere else cannot move it.
 */
export type EmailHistoryCursor = {
  /** The anchor row's `createdAt`, as the ISO instant it round-trips through. */
  createdAt: string;
  /** The anchor row's id, which breaks ties inside a bulk send's millisecond. */
  id: string;
};

/**
 * Bound on the encoded token. A real cursor is an ISO instant, a separator and
 * a cuid — about 68 base64url characters — so this is generous and still keeps
 * a hostile URL from pushing an unbounded string through the decoder.
 */
export const EMAIL_HISTORY_CURSOR_MAX_LENGTH = 120;

/** Bound on the id half, which must survive being read back out of a token. */
export const EMAIL_HISTORY_CURSOR_ID_MAX_LENGTH = 64;

/**
 * Opaque, not secret.
 *
 * The token carries a `createdAt` and an id that are both already on the page
 * that issued it, so nothing is being hidden. Encoding exists so callers do not
 * hand-assemble positions — a URL naming a raw instant invites exactly the
 * "just add 50" arithmetic this pagination replaced.
 */
export function encodeEmailHistoryCursor(cursor: EmailHistoryCursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, "utf8").toString("base64url");
}

/**
 * Decode `?cursor=`, or refuse it.
 *
 * Every malformed token — wrong charset, over-long, no separator, an instant
 * that does not round-trip — resolves to the newest page rather than throwing.
 * A stale or hand-edited link is a bad anchor, not a broken panel, and the same
 * fallback the status and template parameters take is the right one here.
 */
export function decodeEmailHistoryCursor(
  value: string | string[] | undefined,
): EmailHistoryCursor | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  if (token === "" || token.length > EMAIL_HISTORY_CURSOR_MAX_LENGTH) return null;
  // Checked before decoding: `Buffer.from` silently drops anything outside the
  // alphabet rather than failing, so a token that was never base64url would
  // otherwise decode to some shorter arbitrary string.
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.indexOf("|");
  if (separator <= 0) return null;
  const createdAt = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);

  // Round-trip the instant rather than merely parsing it: `new Date` coerces
  // plenty of strings this page never issued, and a coerced anchor silently
  // pages from a different place than the URL names.
  const parsed = new Date(createdAt);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== createdAt) return null;
  if (id === "" || id.length > EMAIL_HISTORY_CURSOR_ID_MAX_LENGTH) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return { createdAt, id };
}

/**
 * The read a request falls back to whenever it names no usable anchor: no
 * keyset predicate, newest-first order — page one of the current view.
 */
export const EMAIL_HISTORY_DEFAULT_DIRECTION: EmailHistoryDirection = "older";

export function parseEmailHistoryDirection(
  value: string | string[] | undefined,
): EmailHistoryDirection {
  return value === "newer" ? "newer" : EMAIL_HISTORY_DEFAULT_DIRECTION;
}

/** One resolved view: what the URL asked for, after every bound is applied. */
export type EmailHistoryQuery = {
  status: EmailStatusFilter;
  /** A template key this event actually has, or null for every template. */
  template: string | null;
  /** Bounded recipient substring, or "" for no search. */
  query: string;
  /** The anchor row, or null for the newest page of this view. */
  cursor: EmailHistoryCursor | null;
  /** Which side of the anchor to read. Meaningless without a cursor. */
  direction: EmailHistoryDirection;
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
 * Resolve a whole URL into the one bounded view the read and the UI share.
 *
 * The anchor decides the direction, which is why the cursor is decoded once
 * here rather than parsed independently of `?dir=`. `newer` names a side of a
 * specific row; with no row to be newer *than*, it names nothing. Resolved
 * independently, `?dir=newer` with a stale or hand-edited token survived the
 * cursor's own fallback and still flipped the read to ascending — so
 * `emailHistoryKeysetWhere` emitted no predicate, the query ordered by
 * `createdAt asc` across the whole view, and `toEmailHistoryPage` reversed it:
 * the panel answered "the newest emails" with the fifty *oldest* in the log.
 * A missing anchor and a malformed one now land on the same page a bare
 * `/admin/emails` does, which is what `decodeEmailHistoryCursor` already
 * promises for every token it refuses.
 */
export function parseEmailHistoryQuery(
  params: EmailHistorySearchParams,
  templateKeys: readonly string[],
): EmailHistoryQuery {
  const cursor = decodeEmailHistoryCursor(params[EMAIL_HISTORY_PARAMS.cursor]);
  return {
    status: parseEmailStatusFilter(params[EMAIL_HISTORY_PARAMS.status]),
    template: parseEmailTemplateFilter(params[EMAIL_HISTORY_PARAMS.template], templateKeys),
    query: parseEmailRecipientQuery(params[EMAIL_HISTORY_PARAMS.query]),
    cursor,
    direction:
      cursor === null
        ? EMAIL_HISTORY_DEFAULT_DIRECTION
        : parseEmailHistoryDirection(params[EMAIL_HISTORY_PARAMS.direction]),
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
 *
 * The cursor predicate is ANDed in as its own clause rather than merged into
 * the top level, so a future narrowing that also needs an `OR` cannot silently
 * overwrite the keyset and turn paging back into a full re-scan.
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
  const keyset = query ? emailHistoryKeysetWhere(query.cursor, query.direction) : null;
  if (keyset) where.AND = [keyset];
  return where;
}

/**
 * The keyset predicate: a tuple comparison on `(createdAt, id)`, not a bare
 * `createdAt` comparison.
 *
 * This distinction is the whole correctness of the pager. A bulk send writes
 * many rows inside one millisecond, so `createdAt` alone is not unique: `<`
 * would skip every tied row after the anchor, and `<=` would repeat all of
 * them. The disjunction below is the standard row-value comparison —
 * `(createdAt, id) < (a, b)` — written the long way because Prisma has no
 * tuple operator, and because Prisma's own `cursor:` needs the sort key to be a
 * unique index, which `(createdAt, id)` is not.
 *
 * `newer` is the exact mirror: the comparison flips and the caller reverses the
 * ascending result back into newest-first render order.
 */
export function emailHistoryKeysetWhere(
  cursor: EmailHistoryCursor | null,
  direction: EmailHistoryDirection,
): Prisma.EmailDispatchWhereInput | null {
  if (cursor === null) return null;
  const createdAt = new Date(cursor.createdAt);
  return direction === "older"
    ? {
        OR: [
          { createdAt: { lt: createdAt } },
          { createdAt, id: { lt: cursor.id } },
        ],
      }
    : {
        OR: [
          { createdAt: { gt: createdAt } },
          { createdAt, id: { gt: cursor.id } },
        ],
      };
}

/**
 * Newest-first for an `older` read; oldest-first for a `newer` one, so the
 * database returns the rows nearest the anchor rather than the far end of the
 * log. `toEmailHistoryPage` reverses the ascending case back for rendering.
 */
export function emailHistoryOrderByFor(
  direction: EmailHistoryDirection,
): Prisma.EmailDispatchOrderByWithRelationInput[] {
  return direction === "newer"
    ? [{ createdAt: "asc" }, { id: "asc" }]
    : [...emailHistoryOrderBy];
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
  // The direction only means something relative to an anchor, so it is never
  // written without one — and re-encoding the decoded cursor guarantees a
  // malformed token can never be handed back out in a link.
  if (query.cursor !== null) {
    params.set(EMAIL_HISTORY_PARAMS.cursor, encodeEmailHistoryCursor(query.cursor));
    if (query.direction === "newer") params.set(EMAIL_HISTORY_PARAMS.direction, "newer");
  }
  const search = params.toString();
  return search === "" ? EMAIL_HISTORY_PATH : `${EMAIL_HISTORY_PATH}?${search}`;
}

/**
 * A chip's link. Changing which statuses are shown drops the anchor: a position
 * inside one filtered set names no position in another, and carrying it would
 * land an operator in the middle of a set they just narrowed.
 */
export function emailHistoryStatusHref(query: EmailHistoryQuery, status: EmailStatusFilter): string {
  return emailHistoryHref({ ...query, status, cursor: null, direction: "older" });
}

/** The newest page of the current view — the pager's way back to the top. */
export function emailHistoryNewestHref(query: EmailHistoryQuery): string {
  return emailHistoryHref({ ...query, cursor: null, direction: "older" });
}

/**
 * A pager link. Same filters, a new anchor — never the other way round.
 *
 * The anchor is the row at the edge the operator is walking off: the oldest row
 * on screen going older, the newest going newer. Both are rows they actually
 * saw, which is what makes the next page contiguous with this one no matter
 * what was inserted elsewhere in between.
 */
export function emailHistoryOlderHref(query: EmailHistoryQuery, cursor: EmailHistoryCursor): string {
  return emailHistoryHref({ ...query, cursor, direction: "older" });
}

export function emailHistoryNewerHref(query: EmailHistoryQuery, cursor: EmailHistoryCursor): string {
  return emailHistoryHref({ ...query, cursor, direction: "newer" });
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
  /** Always newest-first, whichever direction the read walked. */
  entries: EmailHistoryEntry[];
  /** Rows on this page. Never spoken of as an event-wide or filtered total. */
  shown: number;
  pageSize: number;
  /** True when the page-plus-one probe found a row past this page's old edge. */
  hasOlder: boolean;
  hasNewer: boolean;
  /** Anchors for the two pager links — the rows at this page's own edges. */
  olderCursor: EmailHistoryCursor | null;
  newerCursor: EmailHistoryCursor | null;
  /** Counts across `entries` only — never presented as event-wide totals. */
  shownDelivered: number;
  shownUndelivered: number;
  shownFailed: number;
};

/**
 * Fold a page-plus-one keyset query into an honest page.
 *
 * Everything the panel states comes from this one query. An earlier draft paired
 * it with a separate `count()` to show an exact event-wide total, but the two
 * statements read different snapshots: a dispatch inserted between them let the
 * page print a total that disagreed with the rows underneath it. Rather than
 * narrow that window — a `RepeatableRead` transaction would — the total is gone,
 * and pagination did not bring it back.
 *
 * Nor is there a page number. Numeric paging over this log was the defect this
 * fold now exists in its current form to prevent: `skip` counts rows from the
 * top, so one dispatch inserted while an operator reads — or one `queued` row
 * resolving into `sent` under an active status chip — shifts every later offset
 * and makes "page 2" repeat a row from page 1 or drop one entirely. Anchored to
 * a row the operator actually saw, an insert elsewhere cannot move the boundary.
 *
 * The cost is honest and small: no absolute positions and no page count, which
 * a live log could not have kept true anyway.
 */
export function toEmailHistoryPage(
  rows: readonly EmailDispatchRow[],
  query: EmailHistoryQuery,
): EmailHistoryPage {
  const overflow = rows.length > EMAIL_HISTORY_PAGE_SIZE;
  const window = rows.slice(0, EMAIL_HISTORY_PAGE_SIZE);
  // A `newer` read runs ascending so the database returns the rows nearest the
  // anchor; the table always renders newest-first, so restore that here.
  const ordered = query.direction === "newer" ? [...window].reverse() : window;
  const entries = ordered.map(toEmailHistoryEntry);
  const first = entries[0] ?? null;
  const last = entries.at(-1) ?? null;

  // With no anchor this is the newest page, so nothing is newer by definition.
  // With one, the direction not travelled is known to hold rows: the operator
  // arrived from there.
  const hasOlder = query.cursor === null || query.direction === "older" ? overflow : true;
  const hasNewer = query.cursor === null ? false : query.direction === "newer" ? overflow : true;

  return {
    entries,
    shown: entries.length,
    pageSize: EMAIL_HISTORY_PAGE_SIZE,
    hasOlder,
    hasNewer,
    olderCursor: last ? { createdAt: last.loggedAt, id: last.id } : null,
    newerCursor: first ? { createdAt: first.loggedAt, id: first.id } : null,
    shownDelivered: entries.filter((entry) => entry.delivered).length,
    shownUndelivered: entries.filter((entry) => !entry.delivered).length,
    shownFailed: entries.filter((entry) => entry.status === "failed").length,
  };
}

/**
 * The position line. States how much is on screen and which way the log
 * continues; it states no absolute position and no total, because a keyset
 * pager has neither and a live log could not keep either true.
 */
export function emailHistoryRangeLabel(page: EmailHistoryPage): string {
  if (page.shown === 0) return "No emails in this view.";
  const parts = [
    `Showing ${page.shown} email${page.shown === 1 ? "" : "s"} of this view, newest first.`,
  ];
  if (page.hasNewer) parts.push("Newer emails are on the previous page.");
  parts.push(
    page.hasOlder
      ? "Older emails continue on the next page."
      : "This is the oldest end of this view.",
  );
  return parts.join(" ");
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
  if (query.cursor !== null) {
    return {
      title: "Nothing further in this view",
      body: "There is nothing past the email this page was anchored to — or the log has changed since that link was made. Go back to the newest emails.",
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
