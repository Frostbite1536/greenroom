/**
 * The two sentences that must be identical everywhere they appear
 * (D-C5-16 item 2).
 *
 * Both exist because a security property depends on wording being the *same*,
 * not merely similar, and a constant is the only way to guarantee that across a
 * route handler and the page that renders its form-mode outcome. Two hand-kept
 * copies of a "neutral" message is exactly how a neutral message stops being
 * neutral: the day someone improves one of them, the difference between the two
 * branches becomes readable again.
 *
 * They live here rather than in either route because a page importing from an
 * `app/**\/route.ts` module would couple a rendered surface to a file Next
 * treats specially.
 */

/**
 * `/forgot`'s ONE success response — the same bytes whether or not the address
 * belongs to an account. Reset is the classic account oracle, so this endpoint
 * has no branch a caller can observe.
 */
export const PASSWORD_RESET_NEUTRAL_MESSAGE =
  "If that email address has an account with a password, a reset link is on its way. "
  + "Check your inbox, and your spam folder.";

/**
 * `/reset`'s ONE refusal — for malformed, expired, unknown, credential-less and
 * already-spent tokens alike. It never says which, because "this link was
 * already used" is a statement about someone else's account activity.
 */
export const PASSWORD_RESET_INVALID_TOKEN_MESSAGE =
  "That password reset link is no longer valid. Request a new one and use the most recent email.";
