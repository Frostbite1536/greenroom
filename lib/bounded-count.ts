/**
 * Counting honestly off a bounded read (S20).
 *
 * Every capped read in this codebase materializes cap-plus-one rows and renders
 * the cap, so the array it hands back is a *subset* whenever `truncated` is
 * true. Anything that then prints `array.length` as a total is stating a number
 * it does not know — and stating it with total confidence, which is the worse
 * half of the problem.
 *
 * The rule here is the one the email-history panel settled on: derive every
 * piece of volume language from the single cap-plus-one read, and never issue a
 * second `count()` to "get the real number". A second query eliminates nothing —
 * it just moves the inconsistency to a place where the two values can disagree
 * with each other as well as with the rows on screen. One read, one truth, and
 * a qualifier when that truth is a floor rather than a total.
 */

/** A total when it is one, and an explicit floor when it is not: `500` / `500+`. */
export function boundedCount(count: number, truncated: boolean): string {
  return truncated ? `${count}+` : `${count}`;
}

/**
 * The same number with its noun, pluralized off the real count.
 *
 * `500+ sessions` rather than `500+ session`: the qualifier says there are at
 * least this many, so the plural always agrees with the floor being described.
 */
export function boundedCountLabel(
  count: number,
  truncated: boolean,
  singular: string,
  plural = `${singular}s`,
): string {
  const noun = count === 1 && !truncated ? singular : plural;
  return `${boundedCount(count, truncated)} ${noun}`;
}

/**
 * A derived count is a floor too.
 *
 * The landing page's speaker tally is a distinct-set size over the capped
 * session array: past the cap it can only be an undercount, never an overcount,
 * so it takes the same qualifier as the sessions it was derived from. Named
 * separately from `boundedCount` so a reader can see at the call site that the
 * flag being consulted belongs to a *different* array than the one being
 * counted.
 */
export const derivedBoundedCount = boundedCount;
