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

/** The revealed link is held in component state only; it is never stored. */
export type ReviewerInviteLinkResult = { inviteUrl: string; expiresAt: string | null };

/**
 * The server remains authoritative; this only decides whether to enable the
 * control. An absent or unreadable timestamp is treated as available rather
 * than as a permanent refusal: no invitation has been sent yet (or the client
 * cannot tell), so the server has no cooldown to serve, and leaving the button
 * disabled forever refuses an action the server would allow. A wrongly enabled
 * button costs one honest `INVITE_RESEND_COOLDOWN` refusal; a wrongly disabled
 * one strands the reviewer.
 */
export function canResendReviewerInvite(resendAvailableAt: string | null, now = Date.now()): boolean {
  if (!resendAvailableAt) return true;
  const timestamp = Date.parse(resendAvailableAt);
  return !Number.isFinite(timestamp) || now >= timestamp;
}

/** Rounds up, so the copy never promises a resend earlier than the server allows. */
export function describeReviewerInviteResendWait(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  if (seconds < 60) return "in less than a minute";
  const minutes = Math.ceil(seconds / 60);
  return `in about ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * Honest cooldown copy, replacing a bare "not available yet" that reads as a
 * permanent refusal. `now` is `null` until the client clock has been read, so
 * the server-rendered pass claims neither availability nor a deadline it
 * cannot compute. `null` when there is nothing to wait for.
 */
export function reviewerInviteResendHint(resendAvailableAt: string | null, now: number | null): string | null {
  if (now === null) return "Checking when a resend is available…";
  if (!resendAvailableAt) return null;
  const target = Date.parse(resendAvailableAt);
  if (!Number.isFinite(target)) return "Resend availability is unknown here — try it and the server will confirm.";
  if (now >= target) return null;
  return `Resend available ${describeReviewerInviteResendWait(target - now)}.`;
}

export function reviewerInviteLifecycleText(invite: ReviewerInviteView | null): string | null {
  if (!invite) return null;
  if (invite.state === "accepted") return "Invitation accepted";
  if (invite.state === "expired") return "Invitation expired";
  switch (invite.delivery) {
    case "sent":
      return "Invitation pending acceptance · email sent";
    case "mocked":
      // Nothing was actually emailed, so the operator must be told to hand the
      // link over themselves rather than wait for a delivery that never comes.
      return "Invitation pending acceptance · no email was delivered here, share the invite link";
    case "failed":
      return "Invitation pending acceptance · delivery failed, share the invite link";
    case "pending":
      return "Preparing invitation delivery";
    default:
      return "Invitation pending acceptance";
  }
}

export function reviewerInvitePostNotice(result: ReviewerInvitePostResult): string {
  if (result.state === "active") return "This reviewer already has active access.";
  if (result.state === "pending") return "An invitation is already pending for this reviewer.";
  if (result.delivery === "mocked") return "Reviewer access is ready, but no invitation email is delivered in this environment. Use “Show invite link” on their row and send it to them yourself.";
  if (result.delivery === "failed") return "Reviewer access is ready, but the invitation could not be delivered. Use “Show invite link” on their row, or resend it when available.";
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
    case "INVITE_NOT_FOUND":
      // The reveal endpoint refuses accepted, rotated, and expired invitations
      // with the same code the public accept boundary uses.
      return "There is no live invitation link for this reviewer any more. Send a fresh invitation to generate one.";
    default:
      return fallback;
  }
}
