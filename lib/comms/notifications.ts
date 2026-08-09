import { sanitizeHtml } from "@/lib/sanitize-html";
import { normalizeEmailSubject } from "@/lib/comms/subject";

/**
 * Email bodies for the public submission receipt and the organizer-controlled
 * decision email. Anonymous roster input must not fan out email to co-speakers
 * or staff: a submit creates exactly one receipt for its persisted primary.
 *
 * Pure string builders — no database, no network — so the wording is unit
 * tested and the routes stay thin. Every interpolated value is escaped: these
 * carry speaker-supplied text (titles, comments) into HTML email.
 */
export type NotificationSpeaker = { name: string; email: string };

/**
 * Keep the authoritative primary-speaker receipt attached to this named event
 * template rather than whichever seeded template sorts first.
 */
export const CFP_SUBMITTED_TEMPLATE_KEY = "cfp-submitted";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function paragraph(text: string): string {
  return `<p>${escapeHtml(text)}</p>`;
}

export type SubmissionEmail = { subject: string; html: string };

/**
 * Confirmation to the person who submitted.
 *
 * Deliberately promises only what the product does: the team will follow up by
 * email. No portal link — public submitters have no account (delta #1, Q3).
 */
export function buildSubmissionReceipt(input: {
  eventName: string;
  speaker: NotificationSpeaker;
  title: string;
}): SubmissionEmail {
  return {
    subject: normalizeEmailSubject(`We received your proposal for ${input.eventName}`),
    html: [
      paragraph(`Hi ${input.speaker.name},`),
      paragraph(`Thanks for submitting “${input.title}” to ${input.eventName}.`),
      paragraph("The program team reviews every proposal and will be in touch by email. You don't need to do anything else for now."),
    ].filter(Boolean).join(""),
  };
}

export type ReviewerFeedback = { comment: string };

/**
 * The decision email, optionally carrying reviewer feedback (director's
 * explicit bonus, delta #2 answer 3).
 *
 * Feedback is included **only** when the admin asks for it, and only the
 * comments — never scores, never reviewer names. A speaker learning which
 * reviewer said what, or that they scored 2.4/5, is how a CFP loses speakers.
 */
export function buildDecisionEmail(input: {
  eventName: string;
  speaker: NotificationSpeaker;
  title: string;
  decision: "ACCEPTED" | "REJECTED";
  /** Optional admin-written note, rendered above the feedback. */
  personalNote?: string | null;
  feedback?: ReviewerFeedback[];
}): SubmissionEmail {
  const accepted = input.decision === "ACCEPTED";
  const comments = (input.feedback ?? [])
    .map((entry) => entry.comment.trim())
    .filter((comment) => comment.length > 0);

  const parts = [
    paragraph(`Hi ${input.speaker.name},`),
    accepted
      ? paragraph(`Great news — “${input.title}” has been accepted for ${input.eventName}.`)
      : paragraph(`Thank you for submitting “${input.title}” to ${input.eventName}. We're not able to include it in this year's program.`),
  ];

  if (input.personalNote?.trim()) {
    // Admin-authored: sanitized rather than escaped, so basic formatting survives.
    parts.push(sanitizeHtml(input.personalNote.trim()));
  }

  if (comments.length > 0) {
    parts.push(paragraph(accepted ? "Notes from the review team:" : "Feedback from the review team:"));
    parts.push(`<ul>${comments.map((comment) => `<li>${escapeHtml(comment)}</li>`).join("")}</ul>`);
  }

  parts.push(
    accepted
      ? paragraph("We'll follow up with what we need from you next — profile details, session logistics, and travel.")
      : paragraph("We'd genuinely welcome a proposal from you next time."),
  );

  return {
    subject: normalizeEmailSubject(accepted ? `Your talk was accepted for ${input.eventName}` : `Update on your ${input.eventName} submission`),
    html: parts.join(""),
  };
}
