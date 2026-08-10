/**
 * Public short aliases for the embed surfaces.
 *
 * `/schedule`, `/agenda`, `/sessions`, and `/speakers` are the URLs a visitor
 * (or an agent crawling the site) guesses first. They are thin redirects onto
 * the canonical `/embed/*` pages rather than second implementations, so there
 * is exactly one public schedule and one public speaker page.
 */
export type EmbedSurfacePath = "/embed/schedule" | "/embed/speakers";

/**
 * Carry an explicit `?event=` through the redirect. The embed pages accept it,
 * so an alias must not silently drop it and land the visitor on a different
 * event's programme.
 */
export function embedAliasTarget(surface: EmbedSurfacePath, event?: string): string {
  const trimmed = event?.trim();
  return trimmed ? `${surface}?event=${encodeURIComponent(trimmed)}` : surface;
}
