/** MAYBE is a review state available only before a confirmed Session exists. */
export function canOfferMaybeDecision(hasSession: boolean): boolean {
  return !hasSession;
}
