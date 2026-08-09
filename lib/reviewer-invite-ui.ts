/** Token-free UI helpers for the admin reviewer-invite flow. */

export type ReviewerInviteDelivery = "not_sent" | "pending" | "mocked" | "sent" | "failed";
export type ReviewerInviteState = "pending" | "accepted" | "expired";

export type ReviewerInviteView = {
  state: ReviewerInviteState;
  expiresAt: string;
  resendAvailableAt: string | null;
  delivery: ReviewerInviteDelivery;
};

export type ReviewerInvitePostResult = {
  state: "pending" | "invited" | "active";
  access: "active";
  expiresAt: string | null;
  resendAvailableAt: string | null;
  delivery: ReviewerInviteDelivery;
};

/** The server remains authoritative; this only decides whether to enable the control. */
export function canResendReviewerInvite(resendAvailableAt: string | null, now = Date.now()): boolean {
  if (!resendAvailableAt) return false;
  const timestamp = Date.parse(resendAvailableAt);
  return Number.isFinite(timestamp) && now >= timestamp;
}

export function reviewerInviteLifecycleText(invite: ReviewerInviteView | null): string | null {
  if (!invite) return null;
  if (invite.state === "accepted") return "Invitation accepted";
  if (invite.state === "expired") return "Invitation expired";
  switch (invite.delivery) {
    case "sent":
      return "Invitation pending acceptance · email sent";
    case "mocked":
      return "Invitation pending acceptance · delivery is mocked here";
    case "failed":
      return "Invitation pending acceptance · delivery failed";
    case "pending":
      return "Preparing invitation delivery";
    default:
      return "Invitation pending acceptance";
  }
}

export function reviewerInvitePostNotice(result: ReviewerInvitePostResult): string {
  if (result.state === "active") return "This reviewer already has active access.";
  if (result.state === "pending") return "An invitation is already pending for this reviewer.";
  if (result.delivery === "mocked") return "Reviewer access is ready. Invitation delivery is mocked in this environment.";
  if (result.delivery === "failed") return "Reviewer access is ready, but the invitation could not be delivered. You can resend it when available.";
  if (result.delivery === "sent") return "Reviewer access is ready and the invitation was sent.";
  return "Reviewer access is ready and the invitation is being prepared.";
}

export function reviewerInviteFailureMessage(code: string, fallback: string): string {
  switch (code) {
    case "REVIEWER_ROLE_CONFLICT":
      return "This person is already a speaker for this event, so they cannot also be invited to review.";
    case "INVITE_RESEND_COOLDOWN":
      return "Please wait before sending another invitation to this reviewer.";
    case "INVITE_RATE_LIMITED":
      return "This event has reached its reviewer invitation limit. Try again later.";
    case "INVITE_UNAVAILABLE":
      return "Reviewer invitations are temporarily unavailable. Try again shortly.";
    default:
      return fallback;
  }
}
