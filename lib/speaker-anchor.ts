/**
 * Stable public anchors for speaker cards.
 *
 * A session card names its speakers and a speaker card names their sessions,
 * but until now only one of those two was a link: you could get from a speaker
 * to a talk and not back. Closing the loop needs an id the *schedule* page can
 * compute for a name it is rendering, and the *speakers* page can put on the
 * matching card — without either page holding the other's data.
 *
 * It is derived from the speaker's name and NOT from their user id, on purpose.
 * `buildPublicSpeakers` deliberately drops user ids before the gallery is
 * serialized ("used only for server-side deduplication and never leave this
 * serializer"), and a source test forbids `speaker.id` in the component. The
 * public agenda read likewise selects `user.name` alone. Deriving the anchor
 * from the one field both projections already publish keeps that boundary
 * intact and needs no schema or read change.
 *
 * The cost is honest and bounded: two speakers with the identical display name
 * share an anchor, so a cross-link lands on the first of them. That is a
 * strictly better outcome than the previous behaviour, which was no link at
 * all, and it never leaks an identifier or mislabels a card.
 */

/**
 * A short, deterministic fallback for a name that contains no characters the
 * slug rule keeps (an all-CJK or all-punctuation name). djb2 over the code
 * units, base36 — enough to be a valid, stable, collision-shy fragment.
 */
function nameHash(name: string): string {
  let hash = 5381;
  for (let i = 0; i < name.length; i += 1) {
    hash = ((hash << 5) + hash + name.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * The URL-fragment slug for a speaker's name: "Théo Lindqvist" -> "theo-lindqvist".
 *
 * Diacritics are decomposed and stripped rather than replaced with dashes, so
 * an accented name produces a readable anchor instead of "th-o-lindqvist".
 * Both pages call this on the same string, so whatever it returns, they agree.
 */
export function speakerAnchorSlug(name: string): string {
  const slug = name
    .normalize("NFD")
    // Combining marks left behind by the decomposition above.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return slug || `s-${nameHash(name)}`;
}

/** The `id` a speaker card carries, and the fragment a session card links to. */
export function speakerAnchorId(name: string): string {
  return `speaker-${speakerAnchorSlug(name)}`;
}

/** A full link from a session card to that speaker's card on the directory. */
export function speakerAnchorHref(speakersUrl: string, name: string): string {
  return `${speakersUrl}#${speakerAnchorId(name)}`;
}
