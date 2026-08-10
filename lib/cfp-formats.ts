/**
 * The session formats a submitter can choose, shared by the public CFP form and
 * the builder's live preview.
 *
 * These live outside `components/cfp-form.tsx` so the builder can preview a
 * conditional rule against the built-in `format` question without importing the
 * whole public form. The value is what a submission stores and what a
 * `LogicRule` on `format` compares against; the label is only wording.
 *
 * The server deliberately does not treat this as a closed set — see the note on
 * `BUILT_IN_SUBMISSION_SOURCES` in `lib/services/form-shape-validation.ts` — so
 * this is the picker's catalogue, never a validation allowlist.
 */
export type SessionFormat = { label: string; value: string; minutes: number };

export const SESSION_FORMATS: readonly SessionFormat[] = [
  { label: "Lightning talk (10 min)", value: "Lightning Talk", minutes: 10 },
  { label: "Talk (30 min)", value: "Talk", minutes: 30 },
  { label: "Deep dive (45 min)", value: "Deep Dive", minutes: 45 },
  { label: "Workshop (90 min)", value: "Workshop", minutes: 90 },
];

/** What the picker starts on, in both the public form and the preview. */
export const DEFAULT_SESSION_FORMAT = SESSION_FORMATS[1].value;
