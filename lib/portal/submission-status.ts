/**
 * Plain-language submission status for the speaker portal.
 *
 * Greenroom's end users are event professionals, not engineers: the portal must
 * never show a speaker `UNDER_REVIEW` or an error code. Every string here is
 * what a speaker reads, so it says what happened and what happens next.
 */
export type SubmissionStatus = "DRAFT" | "SUBMITTED" | "UNDER_REVIEW" | "ACCEPTED" | "REJECTED" | "WITHDRAWN";

export type SubmissionStatusView = {
  label: string;
  /** One sentence of "what this means for you", written to a speaker. */
  detail: string;
  tone: "neutral" | "info" | "good" | "warn" | "bad";
  /** Terminal outcomes are read-only; matches the backend's canEdit rule. */
  editable: boolean;
};

const VIEWS: Record<SubmissionStatus, SubmissionStatusView> = {
  DRAFT: {
    label: "Draft",
    detail: "Not sent to the program team yet. You can keep working on it.",
    tone: "neutral",
    editable: true,
  },
  SUBMITTED: {
    label: "Submitted",
    detail: "Received. The program team will review it and let you know by email.",
    tone: "info",
    editable: true,
  },
  UNDER_REVIEW: {
    label: "In review",
    detail: "Reviewers are reading it now. You can still make changes.",
    tone: "info",
    editable: true,
  },
  ACCEPTED: {
    label: "Accepted",
    // Honest by design (audit1#8): once a talk is converted to a session, the
    // public listing is the session record, and editing the proposal does NOT
    // change it. Promising otherwise would be a lie a speaker only discovers
    // when the programme still shows their old title.
    detail: "You're on the program. You can still update your proposal, and the team will pick up any changes.",
    tone: "good",
    editable: true,
  },
  REJECTED: {
    label: "Not accepted",
    detail: "This one didn't make the program this time, so it can no longer be edited.",
    tone: "bad",
    editable: false,
  },
  WITHDRAWN: {
    label: "Withdrawn",
    detail: "This proposal was withdrawn, so it can no longer be edited.",
    tone: "warn",
    editable: false,
  },
};

const FALLBACK: SubmissionStatusView = {
  label: "Submitted",
  detail: "The program team will follow up by email.",
  tone: "neutral",
  editable: false,
};

/** Never throws on an unknown status: a speaker sees neutral copy, not a crash. */
export function submissionStatusView(status: string): SubmissionStatusView {
  return VIEWS[status as SubmissionStatus] ?? FALLBACK;
}

/**
 * Turn a backend failure into something a speaker can act on.
 *
 * The contract's codes are precise but unreadable (`SPEAKERS_LOCKED`), and the
 * portal must never render one. Unknown codes fall back to the server's own
 * message, which is already written in prose.
 */
/**
 * What editing actually affects, told plainly.
 *
 * Before a talk is scheduled, the proposal *is* the record. Afterwards the
 * confirmed session drives the public schedule and embeds, so an edit here is a
 * request to the programme team rather than a live change (INV-DOMAIN-001:
 * conversion copies the fields once and the session stays authoritative).
 */
export function editScopeNotice(converted: boolean): string {
  return converted
    ? "Your talk is already on the programme. This page is your proposal record — changes here don't update the public schedule listing, so the programme team will apply anything that matters."
    : "Changes here update your proposal directly.";
}

export function submissionErrorMessage(code: string, serverMessage?: string): string {
  switch (code) {
    case "UNAUTHENTICATED":
      return "Your session expired. Sign in again to keep editing.";
    case "NOT_YOUR_SUBMISSION":
      return "This proposal belongs to someone else, so you can't open it.";
    case "ABSTRACT_NOT_FOUND":
      return "We couldn't find this proposal. It may have been removed.";
    case "ABSTRACT_LOCKED":
      return "This proposal can no longer be edited. Contact the program team if something needs to change.";
    case "SPEAKERS_LOCKED":
      return "Your talk is already on the program, so the speaker list is fixed. Contact the program team to change who's presenting.";
    case "TOO_FEW_SPEAKERS":
      return "This form needs at least one more speaker.";
    case "TOO_MANY_SPEAKERS":
      return "You've added more speakers than this form allows.";
    case "NO_PRIMARY_SPEAKER":
      return "Mark one speaker as the main contact.";
    case "INVALID_CATEGORY":
      return "Pick a track from the list.";
    case "FIELD_ERRORS":
    case "VALIDATION_ERROR":
      return "Some answers need attention — see the highlighted questions below.";
    case "NETWORK_ERROR":
      return "We couldn't reach the server. Check your connection and try again.";
    default:
      return serverMessage && !/^[A-Z_]+$/.test(serverMessage)
        ? serverMessage
        : "Something went wrong saving your changes. Please try again.";
  }
}
