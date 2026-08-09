/** RFC-style header hardening shared by every email builder and sender. */
export const EMAIL_SUBJECT_MAX_LENGTH = 200;

export function normalizeEmailSubject(value: string, maxLength = EMAIL_SUBJECT_MAX_LENGTH): string {
  return value
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}
