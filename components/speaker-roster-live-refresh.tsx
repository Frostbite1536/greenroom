"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pause, Play, RefreshCw } from "lucide-react";
import {
  mayManuallyRefreshSpeakerRoster,
  mayRefreshSpeakerRoster,
  SPEAKER_ROSTER_REFRESH_INTERVAL_MS,
  speakerRosterRefreshStatus,
  type SpeakerRosterRefreshBlockers,
} from "@/lib/speaker-roster-live-refresh";

function liveRefreshBlockers(paused: boolean, pending: boolean): SpeakerRosterRefreshBlockers {
  // Client components still render an initial shell on the server. Browser
  // state is only a guard against a subsequent client-side refresh, never a
  // reason this static roster shell may fail to render.
  if (typeof document === "undefined") {
    return {
      paused,
      hidden: false,
      focused: true,
      dialogOpen: false,
      dirtyEditor: false,
      editableFocused: false,
      pending,
    };
  }
  const active = document.activeElement;
  const editableFocused = active instanceof HTMLElement && active.matches(
    "input:not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly]), select:not([disabled]), [contenteditable='true']",
  );
  return {
    paused,
    hidden: document.hidden,
    focused: document.hasFocus(),
    dialogOpen: document.querySelector("dialog[open]") !== null,
    dirtyEditor: document.querySelector("[data-speaker-roster-refresh-blocker='true']") !== null,
    editableFocused,
    pending,
  };
}

/**
 * The only client island on the otherwise server-rendered roster that polls.
 * It asks Next to refresh the current route, preserving its query and filter,
 * and deliberately makes no client fetch or new API request of its own.
 */
export function SpeakerRosterLiveRefresh() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [paused, setPaused] = useState(false);
  const [lastRefreshRequestedAt, setLastRefreshRequestedAt] = useState<number | null>(null);
  const [browserState, setBrowserState] = useState(0);
  const blockers = liveRefreshBlockers(paused, pending);
  const mayRefresh = mayRefreshSpeakerRoster(blockers);
  const mayManuallyRefresh = mayManuallyRefreshSpeakerRoster(blockers);

  const requestRefresh = useCallback((manual: boolean) => {
    const current = liveRefreshBlockers(paused, pending);
    if (manual ? !mayManuallyRefreshSpeakerRoster(current) : !mayRefreshSpeakerRoster(current)) return;
    // `router.refresh()` does not expose a completion promise. Timestamping the
    // request and saying so is truthful; this control never claims data arrived.
    setLastRefreshRequestedAt(Date.now());
    startTransition(() => router.refresh());
  }, [paused, pending, router, startTransition]);

  useEffect(() => {
    const reconsider = () => setBrowserState((value) => value + 1);
    document.addEventListener("visibilitychange", reconsider);
    document.addEventListener("focusin", reconsider);
    document.addEventListener("focusout", reconsider);
    window.addEventListener("focus", reconsider);
    window.addEventListener("blur", reconsider);
    const observer = new MutationObserver(reconsider);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["open", "data-speaker-roster-refresh-blocker"],
      subtree: true,
    });
    return () => {
      document.removeEventListener("visibilitychange", reconsider);
      document.removeEventListener("focusin", reconsider);
      document.removeEventListener("focusout", reconsider);
      window.removeEventListener("focus", reconsider);
      window.removeEventListener("blur", reconsider);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    let timeout: number | undefined;
    let cancelled = false;
    const schedule = () => {
      timeout = window.setTimeout(() => {
        if (cancelled) return;
        requestRefresh(false);
        schedule();
      }, SPEAKER_ROSTER_REFRESH_INTERVAL_MS);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [browserState, requestRefresh, paused, pending]);

  return (
    <div className="speaker-roster-live-refresh" role="group" aria-label="Speaker roster refresh">
      <div>
        <span className={mayRefresh ? "status-dot" : "status-dot muted"} aria-hidden="true" />
        <span className="hint">
          {speakerRosterRefreshStatus(blockers, lastRefreshRequestedAt)}
        </span>
      </div>
      <div className="row wrap">
        <button className="ghost-button" type="button" disabled={!mayManuallyRefresh} onClick={() => requestRefresh(true)}>
          <RefreshCw size={15} aria-hidden="true" /> {pending ? "Refreshing…" : "Refresh"}
        </button>
        <button className="ghost-button" type="button" onClick={() => setPaused((value) => !value)}>
          {paused ? <Play size={15} aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}
          {paused ? "Resume live refresh" : "Pause live refresh"}
        </button>
      </div>
    </div>
  );
}
