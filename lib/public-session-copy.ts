/**
 * What a confirmed talk is allowed to say about itself on a public surface.
 *
 * `Session.description` is a single column serving two very different readers.
 * When a talk is provisioned from an accepted proposal it carries the speaker's
 * own attendee-facing summary, which is exactly what an attendee wants. But a
 * session can also be authored with internal, operational prose describing
 * *where the row came from* rather than what the talk is about — and that text
 * has no business on a programme page or inside a downloaded calendar file.
 *
 * So every public consumer reads a session's description through here:
 *
 *  - a blank description is `null`, never an empty paragraph;
 *  - a known internal provenance sentence is treated exactly like a missing
 *    description, so the honest fallback shows instead;
 *  - anything else is the speaker's or organizer's real copy and is passed
 *    through untouched.
 *
 * The list below is deliberately an **exact, whole-string** match on the two
 * provenance sentences `lib/demo/seed.ts` writes (`:648` and `:658`). It is a
 * boundary guard, not a content filter: it must never be widened into
 * substring or keyword matching, which would start silently swallowing a real
 * speaker's summary that happened to contain one of these words. The upstream
 * fix — seeded sessions carrying real attendee-facing prose — belongs to the
 * seed-realism lane; this guard is what keeps the text off the public site in
 * the meantime, and keeps it off again after any reseed.
 */

/**
 * Internal provenance sentences that describe a row's origin, not its content.
 * Matched whole and trimmed; never as substrings.
 */
export const INTERNAL_SESSION_DESCRIPTIONS: readonly string[] = [
  "Confirmed session converted from an accepted abstract.",
  "Invited keynote (guaranteed session, no source abstract).",
];

/**
 * What a public surface says when a talk genuinely has no published summary.
 *
 * It states the absence rather than inventing a description or filling the
 * space with the operational note that used to sit there.
 */
export const PUBLIC_SESSION_SUMMARY_FALLBACK =
  "A summary for this session has not been published yet.";

/**
 * The session summary a public reader may see, or `null` when there is none.
 *
 * Returning `null` (rather than the fallback string) is what lets a caller
 * decide between omitting the element entirely and rendering the fallback —
 * the schedule card wants the fallback, a search index wants nothing.
 */
export function publicSessionDescription(description: string | null | undefined): string | null {
  const text = description?.trim();
  if (!text) return null;
  return INTERNAL_SESSION_DESCRIPTIONS.includes(text) ? null : text;
}

/**
 * The same value as a string that is always safe to print: the real summary
 * when one exists, else the honest fallback.
 */
export function publicSessionSummary(description: string | null | undefined): string {
  return publicSessionDescription(description) ?? PUBLIC_SESSION_SUMMARY_FALLBACK;
}
