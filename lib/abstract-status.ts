/**
 * The one vocabulary for an `AbstractStatus` on organizer surfaces.
 *
 * `/admin/abstracts` owns the status filter, and its chips are the definition
 * every other screen has to agree with: a dashboard funnel segment that links
 * into that page is only honest if it carries the chip's own label, its own
 * ordering, and a parameter the page actually reads. Keeping all three here
 * means a new status cannot be added to the schema without this file failing to
 * compile — `ABSTRACT_STATUS_META` is an exhaustive `Record<AbstractStatus, …>`
 * and `ABSTRACT_STATUS_TABS` is checked against it by
 * `abstract-status.test.ts`.
 *
 * `?status=` is the query parameter, matching the page's existing convention:
 * `?abstract=`, `?abstractId=`, `?planId=` and `?mode=` are all read
 * server-side and handed to the client table as an `initial…` prop, so the
 * first response already reflects the URL. This one is read the same way.
 */
import type { AbstractStatus } from "@prisma/client";

export type AbstractStatusMeta = { label: string; tone: string };

/**
 * Exhaustive by construction. `REJECTED` reads "Declined" because that is the
 * word an organizer uses to a speaker; nothing here renames a stored value.
 */
export const ABSTRACT_STATUS_META = {
  DRAFT: { label: "Draft", tone: "neutral" },
  SUBMITTED: { label: "Submitted", tone: "info" },
  UNDER_REVIEW: { label: "Under review", tone: "warn" },
  MAYBE: { label: "Maybe", tone: "warn" },
  ACCEPTED: { label: "Accepted", tone: "good" },
  REJECTED: { label: "Declined", tone: "bad" },
  WITHDRAWN: { label: "Withdrawn", tone: "neutral" },
} satisfies Record<AbstractStatus, AbstractStatusMeta>;

/** The "no filter" chip. Not an `AbstractStatus`, so it is named separately. */
export const ABSTRACT_STATUS_ALL = "ALL";

export type AbstractStatusFilter = AbstractStatus | typeof ABSTRACT_STATUS_ALL;

/**
 * The status filter chips, in the order they are rendered.
 *
 * Every key other than `ALL` must be a real `AbstractStatus`, because the
 * filter is an equality test against `a.status` — a chip whose key names no
 * status silently shows an empty table rather than failing.
 *
 * `WITHDRAWN` sits last, matching the tail of `ABSTRACT_STATUS_META`: it is an
 * outcome nobody decided, so it does not belong among the decision chips.
 * `DRAFT` reads "Drafts" here because the chip labels a bucket, not one row.
 */
export const ABSTRACT_STATUS_TABS: { key: AbstractStatusFilter; label: string }[] = [
  { key: ABSTRACT_STATUS_ALL, label: "All" },
  { key: "SUBMITTED", label: "Submitted" },
  { key: "UNDER_REVIEW", label: "Under review" },
  { key: "MAYBE", label: "Maybe" },
  { key: "ACCEPTED", label: "Accepted" },
  { key: "REJECTED", label: "Declined" },
  { key: "DRAFT", label: "Drafts" },
  { key: "WITHDRAWN", label: "Withdrawn" },
];

/** The statuses a funnel walks, in chip order and without the `ALL` chip. */
export const ABSTRACT_FUNNEL_STATUSES: AbstractStatus[] = ABSTRACT_STATUS_TABS
  .filter((tab): tab is { key: AbstractStatus; label: string } => tab.key !== ABSTRACT_STATUS_ALL)
  .map((tab) => tab.key);

/** The query parameter `/admin/abstracts` reads to preselect a chip. */
export const ABSTRACT_STATUS_FILTER_PARAM = "status";

/**
 * Normalize `?status=` into a chip key.
 *
 * Anything unrecognized — a made-up value, a repeated parameter, a lowercase
 * spelling — falls back to `ALL`. Guessing at a near-miss would silently show a
 * different set of proposals than the URL names, and refusing the whole page
 * over a stale link would be worse than rendering the unfiltered table.
 */
export function parseAbstractStatusFilter(value: string | string[] | undefined): AbstractStatusFilter {
  if (typeof value !== "string") return ABSTRACT_STATUS_ALL;
  const trimmed = value.trim();
  const tab = ABSTRACT_STATUS_TABS.find((candidate) => candidate.key === trimmed);
  return tab ? tab.key : ABSTRACT_STATUS_ALL;
}

/**
 * The link that opens `/admin/abstracts` with one chip already pressed.
 *
 * `ALL` produces the bare path rather than `?status=ALL`: the unfiltered table
 * is the page's own default, and a parameter that changes nothing is noise in a
 * shared URL.
 */
export function abstractStatusFilterHref(key: AbstractStatusFilter): string {
  if (key === ABSTRACT_STATUS_ALL) return "/admin/abstracts";
  return `/admin/abstracts?${ABSTRACT_STATUS_FILTER_PARAM}=${encodeURIComponent(key)}`;
}
