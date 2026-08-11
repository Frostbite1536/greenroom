/**
 * The deep link that opens one proposal's drawer on `/admin/abstracts`.
 *
 * `/admin/abstracts?abstract=<id>` is the canonical, shareable form: an
 * organizer who spots a coverage gap on the evaluations screen can be sent
 * straight to the submission it belongs to, and the link survives a paste into
 * a chat message or a browser reload.
 *
 * `?abstractId=` remains accepted, unchanged. It is the parameter the drawer
 * already used internally and the one every existing link and smoke assertion
 * carries, so dropping it would break working links to fix nothing.
 *
 * Resolution is **server-side and event-scoped**, and that scoping does not
 * live here: this module only reads the URL. `getAdminAbstracts` resolves the
 * id against the caller's own event (INV-EVENT-001 / S1), so an id belonging to
 * another event is indistinguishable from one that does not exist — both yield
 * no drawer. The page must degrade to a normal render in that case rather than
 * erroring: a stale or mistyped link is a routine event, not a fault.
 */

/** The canonical, shareable query parameter. */
export const ABSTRACT_PERMALINK_PARAM = "abstract";

/** The original parameter, still honoured so existing links keep working. */
export const ABSTRACT_PERMALINK_LEGACY_PARAM = "abstractId";

/** What Next hands a page for one search parameter. */
type SearchParamValue = string | string[] | undefined;

function readSingle(value: SearchParamValue): string | null {
  // A repeated parameter (`?abstract=a&abstract=b`) is ambiguous. Picking one
  // would be a guess about which proposal the reader meant, so both are
  // refused and the page renders without a drawer.
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The requested abstract id, or null when the URL names none usably.
 *
 * `abstract` wins over `abstractId` when a link somehow carries both: it is the
 * canonical parameter, so a reader pasting a new-style link cannot have it
 * silently overridden by a stale one left in the query string.
 */
export function readAbstractPermalinkId(params: {
  [ABSTRACT_PERMALINK_PARAM]?: SearchParamValue;
  [ABSTRACT_PERMALINK_LEGACY_PARAM]?: SearchParamValue;
}): string | null {
  return readSingle(params[ABSTRACT_PERMALINK_PARAM])
    ?? readSingle(params[ABSTRACT_PERMALINK_LEGACY_PARAM]);
}

/**
 * The canonical link to one proposal's drawer.
 *
 * The id is encoded, so a value carrying `&`, `#`, or a space cannot break out
 * of its own parameter and forge another one.
 */
export function abstractPermalink(abstractId: string): string {
  return `/admin/abstracts?${ABSTRACT_PERMALINK_PARAM}=${encodeURIComponent(abstractId)}`;
}
