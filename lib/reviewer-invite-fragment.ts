/** Browser-only invite fragment helpers. Bearers are never valid in a query string. */

const MAX_INVITE_TOKEN_LENGTH = 1_024;

export function hasReviewerInviteFragment(hash: string): boolean {
  if (!hash.startsWith("#")) return false;
  return new URLSearchParams(hash.slice(1)).has("invite");
}

/** Reject partial, duplicated, or oversized bearer fragments rather than guessing. */
export function parseReviewerInviteFragment(hash: string): string | null {
  if (!hasReviewerInviteFragment(hash)) return null;
  const params = new URLSearchParams(hash.slice(1));
  if (params.size !== 1 || params.getAll("invite").length !== 1) return null;
  const token = params.get("invite");
  return typeof token === "string" && token.length > 0 && token.length <= MAX_INVITE_TOKEN_LENGTH
    ? token
    : null;
}

/** A capability-bearing fragment is removed rather than added to browser history. */
export function withoutReviewerInviteFragment(pathname: string, search: string): string {
  return `${pathname}${search}`;
}
