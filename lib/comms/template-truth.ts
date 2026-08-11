import { TEMPLATE_VARIABLES } from "@/lib/comms/template-edit";
import {
  buildDecisionEmail,
  buildSubmissionReceipt,
  CFP_SUBMITTED_TEMPLATE_KEY,
  type SubmissionEmail,
} from "@/lib/comms/notifications";

/**
 * One answer, in one place, to "does editing this template change what we send?"
 *
 * The defect this closes (audit4#30): every stored `EmailTemplate` was editable
 * in the operator console and the console said the edit would be used, but the
 * submission receipt and both decision emails were rendered by fixed code and
 * only *logged* against the template row. An operator could rewrite the
 * acceptance email, see their words in the preview, and a speaker would receive
 * something else entirely.
 *
 * Rather than guess per call site, each template key declares which of two
 * honest states it is in:
 *
 * - `stored` — the stored subject/body genuinely drive the send through the
 *   escaped variable engine (`renderEmailTemplate`). Editing works and the
 *   preview is the real message.
 * - `fixed`  — the message is built in code because it carries structure the
 *   placeholder engine cannot express safely. The template is read-only
 *   *server-side*, and the preview shows the real fixed message.
 *
 * Pure and dependency-free (no Prisma, no network) so the API route, the send
 * paths, and the client console all read the same table.
 */

export type TemplateDeliveryMode = "stored" | "fixed";

export type TemplateDelivery = {
  mode: TemplateDeliveryMode;
  /** True only when an admin edit really reaches the delivered message. */
  editable: boolean;
  /** Plain-language statement of what drives the send. Safe for UI copy. */
  summary: string;
  /** Present on `fixed` templates: why it is not editable, and where the real preview lives. */
  reason?: string;
};

/** Sample values shared with `previewTemplate`, so both previews read alike. */
const SAMPLES = Object.fromEntries(
  TEMPLATE_VARIABLES.map((variable) => [variable.key, variable.sample]),
) as Record<string, string>;

const SAMPLE_SPEAKER = { name: SAMPLES.speakerName, email: "speaker@example.test" };

/**
 * Keys whose delivered message is built by `lib/comms/notifications.ts`.
 *
 * Both decision emails are here for one reason: `buildDecisionEmail` composes
 * an admin-authored note (sanitized, not escaped) and a reviewer-feedback list
 * as *markup*. Expressing that through the placeholder engine would mean
 * inventing an unescaped variable, which is exactly the sanitization boundary
 * S18/S19 established and which no email is worth breaching. Read-only with a
 * truthful preview is the honest state, not a temporary one.
 */
const FIXED_TEMPLATES: Readonly<Record<string, { summary: string; reason: string; preview: () => SubmissionEmail }>> = {
  "cfp-accepted": {
    summary: "Sent by the decision screen using a fixed message, not this wording.",
    reason:
      "The acceptance email is assembled in code because it can carry an organizer's note and the review team's comments as formatting, which the fill-in-the-blanks engine cannot insert safely. Preview and send the exact message for one proposal from Decisions.",
    preview: () =>
      buildDecisionEmail({
        eventName: SAMPLES.eventName,
        speaker: SAMPLE_SPEAKER,
        title: SAMPLES.talkTitle,
        decision: "ACCEPTED",
      }),
  },
  "cfp-rejected": {
    summary: "Sent by the decision screen using a fixed message, not this wording.",
    reason:
      "The decline email is assembled in code because it can carry an organizer's note and the review team's comments as formatting, which the fill-in-the-blanks engine cannot insert safely. Preview and send the exact message for one proposal from Decisions.",
    preview: () =>
      buildDecisionEmail({
        eventName: SAMPLES.eventName,
        speaker: SAMPLE_SPEAKER,
        title: SAMPLES.talkTitle,
        decision: "REJECTED",
      }),
  },
};

/** Human-readable statement of what fires a `stored` template. */
const STORED_SUMMARIES: Readonly<Record<string, string>> = {
  [CFP_SUBMITTED_TEMPLATE_KEY]: "Sent automatically to the submitter when a proposal is submitted.",
  "task-reminder": "Sent when you trigger a speaker reminder.",
  "session-scheduled": "Sent when you trigger a scheduled-session reminder, with the calendar invite attached.",
  "reviewer-invite": "Sent when you invite a reviewer.",
  "calendar-invite": "Sent when you send calendar invites, carrying the invitation each speaker accepts in their own calendar.",
};

const DEFAULT_STORED_SUMMARY = "Sent when you trigger a speaker reminder with this template.";

/**
 * How this template key reaches a recipient.
 *
 * Unknown keys are treated as `stored`: an operator-created template can only
 * be addressed by the reminder trigger, which does render it, so editable is
 * the true answer rather than the cautious one.
 */
export function templateDelivery(key: string): TemplateDelivery {
  const fixed = FIXED_TEMPLATES[key];
  if (fixed) return { mode: "fixed", editable: false, summary: fixed.summary, reason: fixed.reason };
  return { mode: "stored", editable: true, summary: STORED_SUMMARIES[key] ?? DEFAULT_STORED_SUMMARY };
}

export function isEditableTemplateKey(key: string): boolean {
  return templateDelivery(key).editable;
}

/**
 * The real message a `fixed` key sends, rendered by the very function the send
 * path calls — not a transcription of it, which could drift silently.
 *
 * Returns null for `stored` keys, whose honest preview is `previewTemplate`.
 */
export function fixedTemplatePreview(key: string): SubmissionEmail | null {
  return FIXED_TEMPLATES[key]?.preview() ?? null;
}

/** Refusal text for a PATCH aimed at a read-only template. */
export function readOnlyTemplateRefusal(key: string): string {
  return FIXED_TEMPLATES[key]?.reason ?? "This template's wording is fixed and cannot be edited.";
}

/**
 * Variables the submission receipt supplies to its stored template.
 *
 * Deliberately the same three names the seeded `cfp-submitted` body uses. Every
 * value is escaped by `renderEmailTemplate`; none is markup.
 */
export function submissionReceiptVariables(input: {
  eventName: string;
  speakerName: string;
  title: string;
}): Record<string, string> {
  return { speakerName: input.speakerName, eventName: input.eventName, talkTitle: input.title };
}

/** Re-exported so callers get the fallback copy from the same module as the table. */
export { buildSubmissionReceipt };
