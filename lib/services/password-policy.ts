import { PASSWORD_MAX_LENGTH } from "@/lib/password-credential";

/**
 * The strength floor for a password a **person chooses** (D-C5-16 item 2).
 *
 * Deliberately one rule — a length floor — and no dependency. Composition rules
 * ("one digit, one symbol") are the classic way to make a password both harder
 * to remember and easier to guess, because they push everyone onto the same
 * small set of substitutions. Length is the property that actually buys work.
 *
 * This is the floor for *new* credentials only. It is never applied to a sign-in
 * attempt: `lib/services/credential-login.ts` must keep treating every wrong
 * guess identically, and refusing a short guess earlier than a long one would be
 * an oracle. Seeded fixture credentials predate this module and are not re-checked.
 */
export const PASSWORD_MIN_LENGTH = 10;

/** Shown next to the field and repeated verbatim in the refusal. One sentence, one rule. */
export const PASSWORD_POLICY_HINT = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;

export const PASSWORD_TOO_SHORT_MESSAGE = `Choose a password of at least ${PASSWORD_MIN_LENGTH} characters.`;
export const PASSWORD_TOO_LONG_MESSAGE = `That password is longer than ${PASSWORD_MAX_LENGTH} characters.`;
export const PASSWORD_MISMATCH_MESSAGE = "The two passwords do not match.";

export type PasswordPolicyVerdict =
  | { ok: true; password: string }
  | { ok: false; fieldErrors: Record<string, string[]> };

/**
 * Count Unicode code points, not UTF-16 units.
 *
 * `"👩‍🚀".length` is 5, so a naive count would let a three-emoji password clear a
 * ten-character floor. Counting code points can only make the floor stricter,
 * which is the safe direction to be wrong in.
 */
export function passwordLength(password: string): number {
  return [...password].length;
}

/**
 * Check a chosen password (and its confirmation) against the floor.
 *
 * Returns field-scoped messages in the same shape `fromZod` produces, so a route
 * can hand them straight to the 422 body and the form can render them beside the
 * field that caused them. Every failing rule is reported at once: telling someone
 * their password is too short, then that it does not match, then that it is too
 * short again is a bad way to spend three attempts.
 */
export function checkNewPassword(password: unknown, confirm: unknown): PasswordPolicyVerdict {
  const fieldErrors: Record<string, string[]> = {};
  const candidate = typeof password === "string" ? password : "";

  if (passwordLength(candidate) < PASSWORD_MIN_LENGTH) {
    (fieldErrors.password ??= []).push(PASSWORD_TOO_SHORT_MESSAGE);
  } else if (candidate.length > PASSWORD_MAX_LENGTH) {
    // Bounded by UTF-16 length, matching `hashPassword`'s own guard: this is
    // about how much work scrypt is asked to do, not about how many characters
    // the person thinks they typed.
    (fieldErrors.password ??= []).push(PASSWORD_TOO_LONG_MESSAGE);
  }

  // A confirmation is only meaningful once the password itself is usable, but it
  // is still checked independently so both problems surface in one pass.
  if (typeof confirm !== "string" || confirm !== candidate) {
    (fieldErrors.confirmPassword ??= []).push(PASSWORD_MISMATCH_MESSAGE);
  }

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return { ok: true, password: candidate };
}
