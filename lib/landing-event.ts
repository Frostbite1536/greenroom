/**
 * Which programme the public landing page presents.
 *
 * The landing page must present exactly ONE programme. Its agenda, its metrics,
 * its open-CFP entry, its embed links, and its page metadata all have to name
 * the same event, or a visitor sees one event's schedule links beside another
 * event's call for proposals.
 *
 * The rule: an explicit `?event=` is honoured only when it actually resolves.
 * A blank or unknown slug behaves exactly like no slug at all — the default
 * programme drives every surface, which is the same fallback `/embed/schedule`
 * and `/embed/speakers` already apply.
 */
export type LandingEventResolution = {
  /**
   * The event to pass to every public read and link. `undefined` means "the
   * default programme", which every public surface already falls back to.
   */
  eventParam: string | undefined;
  /** An explicit `?event=` was supplied but did not resolve to a programme. */
  fellBackToDefault: boolean;
};

/**
 * Trim and drop a blank `?event=` so it behaves as absent, matching
 * `publicSurfaceUrl()` in `lib/embed-alias.ts`.
 */
export function normalizeLandingEventParam(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveLandingEvent(
  requested: string | undefined,
  requestedResolved: boolean,
): LandingEventResolution {
  const normalized = normalizeLandingEventParam(requested);
  if (!normalized) return { eventParam: undefined, fellBackToDefault: false };
  return requestedResolved
    ? { eventParam: normalized, fellBackToDefault: false }
    : { eventParam: undefined, fellBackToDefault: true };
}
