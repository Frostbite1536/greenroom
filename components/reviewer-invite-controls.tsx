"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { SetupEvaluator } from "@/lib/data/reads";
import { apiPost, firstFieldErrors } from "@/lib/api-client";
import {
  canResendReviewerInvite,
  reviewerInviteFailureMessage,
  reviewerInvitePostNotice,
  type ReviewerInvitePostResult,
} from "@/lib/reviewer-invite-ui";

type InviteInput = { name: string; email: string; resend?: boolean };

async function sendReviewerInvite(input: InviteInput) {
  return apiPost<ReviewerInvitePostResult>("/api/evaluations/reviewer-invites", input);
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
      <p className="hint">They can be assigned now and start reviewing after they accept the invitation.</p>
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

export function ReviewerInviteResend({ reviewer }: { reviewer: SetupEvaluator }) {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [cooldownDenied, setCooldownDenied] = useState(false);
  const invite = reviewer.invite;
  const resendAt = invite?.resendAvailableAt ?? null;

  useEffect(() => {
    setCooldownDenied(false);
    if (!resendAt) return;
    const target = Date.parse(resendAt);
    if (!Number.isFinite(target)) return;
    const update = () => setNow(Date.now());
    update();
    if (target <= Date.now()) return;
    const timeout = window.setTimeout(update, Math.min(target - Date.now(), 2_147_483_647));
    return () => window.clearTimeout(timeout);
  }, [resendAt]);

  if (!invite || invite.state === "accepted") return null;
  const available = !cooldownDenied && canResendReviewerInvite(resendAt, now);
  const cooldownId = `reviewer-resend-${reviewer.userId}`;

  async function resend() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await sendReviewerInvite({ name: reviewer.name, email: reviewer.email, resend: true });
    setBusy(false);
    if (!res.ok) {
      if (res.error.code === "INVITE_RESEND_COOLDOWN") setCooldownDenied(true);
      setError(inviteError(res.error.code, res.error.message, res.error.fieldErrors));
      return;
    }
    setNotice(reviewerInvitePostNotice(res.data));
    startTransition(() => router.refresh());
  }

  return (
    <div className="reviewer-resend">
      <button
        className="link-button"
        type="button"
        disabled={!available || busy || refreshing}
        aria-describedby={!available ? cooldownId : undefined}
        onClick={resend}
      >
        {busy ? "Resending…" : refreshing ? "Updating…" : "Resend invitation"}
      </button>
      {!available ? <span className="hint" id={cooldownId}>Resend is not available yet.</span> : null}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {notice ? <p className="hint setup-ok" role="status">{notice}</p> : null}
    </div>
  );
}
