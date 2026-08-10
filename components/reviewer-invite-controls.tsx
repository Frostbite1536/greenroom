"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy } from "lucide-react";
import type { SetupEvaluator } from "@/lib/data/reads";
import { apiPost, firstFieldErrors } from "@/lib/api-client";
import {
  canResendReviewerInvite,
  reviewerInviteFailureMessage,
  reviewerInviteLifecycleKey,
  reviewerInvitePostNotice,
  reviewerInviteResendHint,
  shouldApplyReviewerInviteReveal,
  type ReviewerInviteLinkResult,
  type ReviewerInvitePostResult,
} from "@/lib/reviewer-invite-ui";

type InviteInput = { name: string; email: string; resend?: boolean };

async function sendReviewerInvite(input: InviteInput) {
  return apiPost<ReviewerInvitePostResult>("/api/evaluations/reviewer-invites", input);
}

/**
 * Ask the server to re-derive this reviewer's pending invite link. The bearer
 * lives in component state for as long as the operator is looking at it and is
 * never written to storage, a URL, or a log line.
 */
async function revealReviewerInviteLink(email: string) {
  return apiPost<ReviewerInviteLinkResult>("/api/evaluations/reviewer-invites/link", { email });
}

function inviteError(code: string, fallback: string, fieldErrors?: Record<string, string[]>): string {
  const fields = firstFieldErrors(fieldErrors);
  return Object.values(fields)[0] ?? reviewerInviteFailureMessage(code, fallback);
}

export function ReviewerInviteForm({ headingLevel = "h4" }: { headingLevel?: "h3" | "h4" }) {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const Heading = headingLevel;

  async function invite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await sendReviewerInvite({ name: name.trim(), email: email.trim() });
    setBusy(false);
    if (!res.ok) {
      setError(inviteError(res.error.code, res.error.message, res.error.fieldErrors));
      return;
    }
    setNotice(reviewerInvitePostNotice(res.data));
    setName("");
    setEmail("");
    startTransition(() => router.refresh());
  }

  return (
    <form className="reviewer-invite" onSubmit={invite} aria-labelledby="reviewer-invite-title">
      <Heading id="reviewer-invite-title">Invite a reviewer</Heading>
      <p className="hint">They get reviewer access for this event and can start reviewing after they accept the invitation.</p>
      <label className="stack">
        <span className="field-label">Name</span>
        <input
          className="text-input"
          name="reviewerName"
          autoComplete="name"
          maxLength={120}
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="stack">
        <span className="field-label">Email address</span>
        <input
          className="text-input"
          type="email"
          name="reviewerEmail"
          autoComplete="email"
          maxLength={254}
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      {error ? <p className="conflict-banner" role="alert">{error}</p> : null}
      {notice ? <p className="hint setup-ok" role="status">{notice}</p> : null}
      <button className="primary-button" type="submit" disabled={busy || refreshing}>
        {busy ? "Sending invitation…" : refreshing ? "Updating reviewers…" : "Invite reviewer"}
      </button>
    </form>
  );
}

/**
 * The pending-invitation action row: resend, and show the invite link so an
 * operator can hand it over when no email was actually delivered.
 */
export function ReviewerInviteResend({ reviewer }: { reviewer: SetupEvaluator }) {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // `null` until the browser clock has been read, so the server-rendered pass
  // never asserts a cooldown position it cannot compute.
  const [now, setNow] = useState<number | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">("idle");
  const linkField = useRef<HTMLInputElement | null>(null);
  // Monotonic per-row reveal id. Bumped by a new reveal and by any lifecycle
  // change, so a response that lost either race is discarded on arrival.
  const revealRequestRef = useRef(0);
  const invite = reviewer.invite;
  const resendAt = invite?.resendAvailableAt ?? null;
  const inviteExpiresAt = invite?.expiresAt ?? null;
  const lifecycleKey = reviewerInviteLifecycleKey(invite);
  // Both sides of the guard must be read through refs. A response resolving
  // after a rotation still closes over the *old* render's `lifecycleKey`, so
  // comparing the closure against itself would always pass.
  const lifecycleKeyRef = useRef(lifecycleKey);

  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    if (!resendAt) return;
    const target = Date.parse(resendAt);
    if (!Number.isFinite(target) || target <= Date.now()) return;
    // Coarse ticks keep the countdown honest without re-rendering every
    // reviewer row every second; the timeout lands the availability moment.
    const interval = window.setInterval(() => {
      const value = Date.now();
      setNow(value);
      if (value >= target) window.clearInterval(interval);
    }, 10_000);
    const timeout = window.setTimeout(update, Math.min(Math.max(target - Date.now(), 0) + 100, 2_147_483_647));
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [resendAt]);

  useEffect(() => {
    // A rotated, accepted, or expired invitation invalidates any bearer still
    // on screen AND any reveal still in flight for the previous lifecycle.
    // Bumping the id first is what stops that older response from putting a
    // pre-rotation bearer back after this clear.
    revealRequestRef.current += 1;
    lifecycleKeyRef.current = lifecycleKey;
    setLink(null);
    setCopyState("idle");
    setLinkBusy(false);
  }, [lifecycleKey]);

  if (!invite || invite.state === "accepted") return null;
  const available = canResendReviewerInvite(resendAt, now ?? 0);
  const resendHint = reviewerInviteResendHint(resendAt, now);
  const cooldownId = `reviewer-resend-${reviewer.userId}`;
  const linkLabelId = `reviewer-invite-link-${reviewer.userId}`;

  async function resend() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await sendReviewerInvite({ name: reviewer.name, email: reviewer.email, resend: true });
    setBusy(false);
    if (!res.ok) {
      setError(inviteError(res.error.code, res.error.message, res.error.fieldErrors));
      if (res.error.code === "INVITE_RESEND_COOLDOWN") {
        startTransition(() => router.refresh());
      }
      return;
    }
    setNotice(reviewerInvitePostNotice(res.data));
    startTransition(() => router.refresh());
  }

  async function showLink() {
    const issued = { requestId: revealRequestRef.current + 1, lifecycleKey };
    revealRequestRef.current = issued.requestId;
    setLinkBusy(true);
    setError(null);
    setNotice(null);
    setCopyState("idle");
    const res = await revealReviewerInviteLink(reviewer.email);
    // Superseded by a newer reveal, or the invitation rotated underneath this
    // one: drop the response untouched. The winner owns the visible state.
    const current = { requestId: revealRequestRef.current, lifecycleKey: lifecycleKeyRef.current };
    if (!shouldApplyReviewerInviteReveal(issued, current)) return;
    setLinkBusy(false);
    if (!res.ok) {
      setLink(null);
      setError(inviteError(res.error.code, res.error.message, res.error.fieldErrors));
      return;
    }
    setLink(res.data.inviteUrl);
  }

  /** Success is claimed only after the clipboard write actually resolves. */
  async function copyLink(url: string) {
    setCopyState("idle");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(url);
      setCopyState("copied");
    } catch (error) {
      // Bounded label only: the failing value is a bearer capability.
      console.warn("Reviewer invite link copy failed", error instanceof Error ? error.name : "unknown");
      setCopyState("manual");
      linkField.current?.focus();
      linkField.current?.select();
    }
  }

  return (
    <div className="reviewer-resend">
      <div className="row wrap">
        <button
          className="link-button"
          type="button"
          disabled={!available || busy || refreshing}
          aria-describedby={resendHint ? cooldownId : undefined}
          onClick={resend}
        >
          {busy ? "Resending…" : refreshing ? "Updating…" : "Resend invitation"}
        </button>
        <button className="link-button" type="button" disabled={linkBusy} onClick={showLink}>
          {linkBusy ? "Preparing link…" : link ? "Refresh invite link" : "Show invite link"}
        </button>
      </div>
      {resendHint ? (
        <span className="hint" id={cooldownId}>
          {resendAt ? <time dateTime={resendAt}>{resendHint}</time> : resendHint}
        </span>
      ) : null}
      {link ? (
        <div className="reviewer-invite-link">
          <label className="stack">
            <span className="field-label" id={linkLabelId}>Single-use invite link</span>
            <input
              className="text-input"
              readOnly
              spellCheck={false}
              value={link}
              ref={linkField}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <div className="row wrap">
            <button className="link-button" type="button" onClick={() => copyLink(link)}>
              {copyState === "copied" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
              {copyState === "copied" ? "Invite link copied" : "Copy invite link"}
            </button>
            <span className="hint" role="status" aria-live="polite">
              {copyState === "manual"
                ? "Clipboard blocked by the browser — the link is selected, press Ctrl/Cmd + C."
                : copyState === "copied"
                  ? "Send it to the reviewer yourself."
                  : ""}
            </span>
          </div>
          <p className="hint">
            Signs this reviewer in once, then stops working. It expires with the invitation. Do not
            post it anywhere public.
          </p>
        </div>
      ) : null}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {notice ? <p className="hint setup-ok" role="status">{notice}</p> : null}
    </div>
  );
}
