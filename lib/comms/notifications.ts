import { sanitizeHtml } from "@/lib/sanitize-html";

/**
 * Email bodies for the three notifications the director asked for
 * (requirements delta #2, answers 3 and 6): a submission confirmation, a
 * co-speaker contact, and a decision email that can carry reviewer feedback.
 *
 * Pure string builders — no database, no network — so the wording is unit
 * tested and the routes stay thin. Every interpolated value is escaped: these
 * carry speaker-supplied text (titles, comments) into HTML email.
 */
export type NotificationSpeaker = { name: string; email: string };

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
  coSpeakers: NotificationSpeaker[];
}): SubmissionEmail {
  const others = input.coSpeakers.filter((person) => person.email !== input.speaker.email);
  return {
    subject: `We received your proposal for ${input.eventName}`,
    html: [
      paragraph(`Hi ${input.speaker.name},`),
      paragraph(`Thanks for submitting “${input.title}” to ${input.eventName}.`),
      others.length > 0
        ? paragraph(`We've also let your co-speaker${others.length === 1 ? "" : "s"} know: ${others.map((person) => person.name).join(", ")}.`)
        : "",
      paragraph("The program team reviews every proposal and will be in touch by email. You don't need to do anything else for now."),
    ].filter(Boolean).join(""),
  };
}

/** Tells a co-speaker they were added, so the first they hear of it isn't the schedule. */
export function buildCoSpeakerNotice(input: {
  eventName: string;
  coSpeaker: NotificationSpeaker;
  submitter: NotificationSpeaker;
  title: string;
}): SubmissionEmail {
  return {
    subject: `You were added to a proposal for ${input.eventName}`,
    html: [
      paragraph(`Hi ${input.coSpeaker.name},`),
      paragraph(`${input.submitter.name} submitted “${input.title}” to ${input.eventName} and listed you as a co-speaker.`),
      paragraph("If that's not right, reply to this email and the program team will sort it out."),
    ].join(""),
  };
}

/** Heads-up to the program team that something landed in the queue. */
export function buildSubmissionAlert(input: {
  eventName: string;
  adminName: string;
  title: string;
  speakers: NotificationSpeaker[];
  categoryName: string | null;
}): SubmissionEmail {
  return {
    subject: `New proposal: ${input.title}`,
    html: [
      paragraph(`Hi ${input.adminName},`),
      paragraph(`“${input.title}” was just submitted to ${input.eventName}.`),
      paragraph(`Speaker${input.speakers.length === 1 ? "" : "s"}: ${input.speakers.map((person) => `${person.name} (${person.email})`).join(", ")}`),
      input.categoryName ? paragraph(`Track: ${input.categoryName}`) : "",
      paragraph("It's waiting in Abstracts whenever the team is ready to review."),
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
    subject: accepted ? `Your talk was accepted for ${input.eventName}` : `Update on your ${input.eventName} submission`,
    html: parts.join(""),
  };
}
