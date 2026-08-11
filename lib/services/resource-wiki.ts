import { sanitizeHtml } from "@/lib/sanitize-html";

/**
 * Resource/wiki authoring rules (buyer requirement 8).
 *
 * The portal has always been able to READ a sanitized resource page; until now
 * the only writer was the demo seed. These helpers are the pieces the new
 * `/api/admin/resources` writer and the portal readers must agree on, kept pure
 * so both the write path and the fold that decides what the portal shows are
 * testable without a database.
 *
 * Two of them exist specifically so a rule cannot drift between surfaces:
 *  - `prepareResourceHtml` is the ONE place authored HTML is sanitized before
 *    it is stored. The reader still sanitizes on render (INV-HTML-001) — this
 *    is defence in depth, not a replacement, because rows can also arrive from
 *    the seed and from any future importer.
 *  - `portalResourceWhere` is the ONE place the published-only rule is spelled
 *    out, and `isPortalVisibleResource` evaluates that same object in memory,
 *    so a test can prove the round trip without re-stating the rule.
 */

/** Longest slug the contract accepts (`resourceSlugSchema` in `types/api.ts`). */
export const RESOURCE_SLUG_MAX_LENGTH = 60;

/** The slug shape the contract and the portal route both assume. */
export const RESOURCE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Combining diacritical marks, as an ASCII-only source literal so this file
 * carries no bare combining character of its own. NFKD decomposes "e-acute"
 * into "e" plus one of these; dropping them turns it into a plain "e" rather
 * than letting the non-alphanumeric pass below turn it into a dash.
 */
const COMBINING_MARKS = new RegExp("[\u0300-\u036f]", "g");

/**
 * Derive a portal address from a title, exactly as `NewFormDialog` derives a
 * CFP form's slug from its name. The organizer can always override it; this is
 * the default so the common case needs no second decision.
 */
export function resourceSlugFromTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, RESOURCE_SLUG_MAX_LENGTH)
    // The slice can cut mid-word and leave a trailing dash, which the slug
    // pattern rejects; strip again so a long title still yields a valid slug.
    .replace(/^-+|-+$/g, "");
}

export const RESOURCE_HTML_EMPTY_CODE = "RESOURCE_HTML_EMPTY";
export const RESOURCE_HTML_EMPTY_MESSAGE =
  "Nothing in this page body survived sanitizing. Scripts, styles, embeds and inline event handlers are always removed — " +
  "write the content as text, headings, lists, tables or links.";

export type ResourceHtmlDecision =
  | { allowed: true; html: string }
  | { allowed: false; code: typeof RESOURCE_HTML_EMPTY_CODE; message: string };

/**
 * Sanitize an authored body for storage, and refuse the write when nothing is
 * left. Storing an empty body would leave the organizer with a live, blank page
 * and no explanation, so a paste that was entirely script/style/embed is a
 * named 422 rather than a silent success.
 *
 * Pure: `sanitizeHtml` is a string transform, so this is directly testable.
 */
export function prepareResourceHtml(rawHtml: string): ResourceHtmlDecision {
  const html = sanitizeHtml(rawHtml).trim();
  if (html === "") {
    return { allowed: false, code: RESOURCE_HTML_EMPTY_CODE, message: RESOURCE_HTML_EMPTY_MESSAGE };
  }
  return { allowed: true, html };
}

/** An optional summary as it is stored: trimmed, or absent rather than blank. */
export function resourceSummaryValue(summary: string | null | undefined): string | null {
  if (summary === undefined || summary === null) return null;
  const trimmed = summary.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The published-only rule the speaker portal reads by, in one place.
 *
 * Both portal surfaces (`/portal` and `/portal/resources/[slug]`) build their
 * `where` from this, so an unpublished draft cannot become visible on one of
 * them and not the other.
 */
export const PORTAL_RESOURCE_VISIBILITY = { published: true } as const;

export function portalResourceWhere(eventId: string): { eventId: string; published: boolean } {
  return { eventId, ...PORTAL_RESOURCE_VISIBILITY };
}

/**
 * The same rule as `portalResourceWhere`, evaluated over a row in memory.
 *
 * Deliberately derived from that function rather than restated, so a change to
 * the query is a change to this predicate too — this is what the authored →
 * published → visible-in-portal round-trip test folds over.
 */
export function isPortalVisibleResource(
  row: { eventId: string; published: boolean },
  eventId: string,
): boolean {
  const where = portalResourceWhere(eventId);
  return row.eventId === where.eventId && row.published === where.published;
}

/** Ordering for the organizer's own list: newest edit first, id as tiebreak. */
export const ADMIN_RESOURCE_ORDER = [{ updatedAt: "desc" as const }, { id: "asc" as const }];

export type ResourceRow = {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  htmlContent: string;
  published: boolean;
  updatedAt: Date;
};

export type ResourceView = {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  htmlContent: string;
  published: boolean;
  updatedAt: string;
};

/** Serialize a stored resource for the authoring client. */
export function serializeResource(row: ResourceRow): ResourceView {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    htmlContent: row.htmlContent,
    published: row.published,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Where this resource lives in the speaker portal once it is published. */
export function portalResourceHref(slug: string): string {
  return `/portal/resources/${slug}`;
}
