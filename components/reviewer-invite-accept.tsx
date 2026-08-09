"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  hasReviewerInviteFragment,
  parseReviewerInviteFragment,
  withoutReviewerInviteFragment,
} from "@/lib/reviewer-invite-fragment";

type InviteState = "preparing" | "ready" | "busy" | "unavailable" | "error" | "unsafe";

function stripReviewerInviteFragment(): { token: string | null; sawInviteFragment: boolean; safeToRequest: boolean } {
  const hash = window.location.hash;
  if (!hasReviewerInviteFragment(hash)) return { token: null, sawInviteFragment: false, safeToRequest: true };
  const token = parseReviewerInviteFragment(hash);
  try {
    window.history.replaceState(
      window.history.state,
      "",
      withoutReviewerInviteFragment(window.location.pathname, window.location.search),
    );
  } catch (error) {
    // The bounded label and browser error contain no URL, token, or request data.
    console.error("Reviewer invite history strip failed", error);
    return { token, sawInviteFragment: true, safeToRequest: false };
  }
  return { token, sawInviteFragment: true, safeToRequest: !hasReviewerInviteFragment(window.location.hash) };
}

function isExpectedReviewerRedirect(response: Response): boolean {
  if (!response.redirected) return false;
  try {
    const finalUrl = new URL(response.url);
    return finalUrl.origin === window.location.origin
      && finalUrl.pathname === "/admin/evaluations"
      && finalUrl.search === "";
  } catch {
    return false;
  }
}

export function ReviewerInviteAccept() {
  const router = useRouter();
  const tokenRef = useRef<string | null>(null);
  const [state, setState] = useState<InviteState>("preparing");

  useLayoutEffect(() => {
    const fragment = stripReviewerInviteFragment();
    if (!fragment.safeToRequest) {
      tokenRef.current = fragment.token;
      setState("unsafe");
      return;
    }
    if (!fragment.token) {
      setState("unavailable");
      return;
    }
    tokenRef.current = fragment.token;
    setState("ready");
  }, []);

  async function continueToWorkspace() {
    // Back/forward can restore a fragment. Strip it again before this async request.
    const fragment = stripReviewerInviteFragment();
    if (!fragment.safeToRequest) {
      setState("unsafe");
      return;
    }
    // A malformed/duplicated invite-looking fragment must not fall back to a
    // previously held bearer after browser back/forward navigation.
    if (fragment.sawInviteFragment) tokenRef.current = fragment.token;
    const token = tokenRef.current;
    if (!token) {
      setState("unavailable");
      return;
    }

    setState("busy");
    try {
      const response = await fetch("/api/auth/reviewer-invites/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
        cache: "no-store",
        credentials: "same-origin",
        referrerPolicy: "no-referrer",
        redirect: "follow",
      });
      if (isExpectedReviewerRedirect(response)) {
        tokenRef.current = null;
        // Never navigate to response.url: only this constant is trusted client navigation.
        router.replace("/admin/evaluations");
        return;
      }
      if (response.status === 404) {
        tokenRef.current = null;
        setState("unavailable");
        return;
      }
      setState("error");
    } catch (error) {
      // Do not include a token, URL, request body, or response in diagnostics.
      console.error("Reviewer invite acceptance request failed", error);
      setState("error");
    }
  }

  if (state === "preparing") {
    return <p className="hint" role="status" aria-live="polite">Preparing your reviewer invitation…</p>;
  }
  if (state === "unavailable") {
    return <p className="conflict-banner" role="alert">This invitation is unavailable. Ask the event administrator for a new invitation.</p>;
  }
  if (state === "unsafe") {
    return <p className="conflict-banner" role="alert">This invitation could not be prepared safely. Reload the invitation link and try again.</p>;
  }

  return (
    <div className="stack">
      <p className="muted">Continue to open your reviewer workspace.</p>
      {state === "error" ? (
        <p className="conflict-banner" role="alert">We could not open your reviewer workspace. Try again.</p>
      ) : null}
      {state === "busy" ? <p className="hint" role="status" aria-live="polite">Opening reviewer workspace…</p> : null}
      <button className="primary-button" type="button" disabled={state === "busy"} onClick={continueToWorkspace}>
        {state === "busy" ? "Opening workspace…" : state === "error" ? "Retry" : "Continue"}
      </button>
    </div>
  );
}
