/**
 * The public programme's URLs.
 *
 * The relationship between these paths is now the reverse of what it was.
 * `/schedule` and `/speakers` used to be thin redirects onto `/embed/*`, which
 * meant the URL a visitor guesses first, and the one a search engine or an
 * agent indexes, was a bare frame-shaped fragment with no site around it.
 *
 * So the programme is now served **at** `/schedule` and `/speakers`, with the
 * site's own header; `/embed/schedule` and `/embed/speakers` remain the
 * chrome-free variant a host page puts in an iframe. Both render the same
 * server components over the same reads — the surface only decides whether the
 * standalone header is drawn — so there is still exactly one public schedule
 * and one public speaker page, not two implementations to drift apart.
 *
 * `/agenda` and `/sessions` stay redirects, and now point at `/schedule`.
 */
export const CANONICAL_SCHEDULE_PATH = "/schedule";
export const CANONICAL_SPEAKERS_PATH = "/speakers";
export const EMBED_SCHEDULE_PATH = "/embed/schedule";
export const EMBED_SPEAKERS_PATH = "/embed/speakers";

export type PublicSurfacePath =
  | typeof CANONICAL_SCHEDULE_PATH
  | typeof CANONICAL_SPEAKERS_PATH
  | typeof EMBED_SCHEDULE_PATH
  | typeof EMBED_SPEAKERS_PATH;

/**
 * Which of the two variants a page is being rendered as. `canonical` draws the
 * standalone site header; `embed` is the frameable one and draws nothing.
 */
export type ProgrammeSurface = "canonical" | "embed";

/** The schedule URL for a surface, so a page never hard-codes the other one. */
export function schedulePathFor(surface: ProgrammeSurface): PublicSurfacePath {
  return surface === "embed" ? EMBED_SCHEDULE_PATH : CANONICAL_SCHEDULE_PATH;
}

/** The speaker-directory URL for a surface. */
export function speakersPathFor(surface: ProgrammeSurface): PublicSurfacePath {
  return surface === "embed" ? EMBED_SPEAKERS_PATH : CANONICAL_SPEAKERS_PATH;
}

/**
 * Carry an explicit `?event=` onto a public programme URL. Every public page
 * accepts it, so a link that dropped it would silently land the visitor on a
 * different event's programme.
 */
export function publicSurfaceUrl(surface: PublicSurfacePath, event?: string): string {
  const trimmed = event?.trim();
  return trimmed ? `${surface}?event=${encodeURIComponent(trimmed)}` : surface;
}
