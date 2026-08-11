"use client";

/**
 * Workspace error boundary (GRA-06).
 *
 * Next requires error boundaries to be Client Components. This one wraps the
 * pages *below* `app/(app)/layout.tsx`, not the layout itself, so the shell
 * survives the failure and an organizer can still navigate away instead of
 * being dropped onto a bare browser error.
 *
 * Copy rule: say honestly that the page did not load and offer the one action
 * that can help. No stack trace, no error code, no `error.message` — for a
 * Server Component failure Next deliberately replaces the message with a
 * generic one in production, so rendering it would show either nothing useful
 * or, in development, internals a user should never see.
 *
 * `retry()` — not `reset()`. Verified against the installed Next 16.3.0:
 * `retry` refreshes the router and re-fetches the segment
 * (`next/dist/client/components/error-boundary.js`), whereas `reset` only
 * clears the boundary's state and re-renders the same failed payload. These
 * pages fail on a failed read, so re-rendering without re-fetching would put
 * the same error straight back.
 */
export default function WorkspaceError({ retry }: { retry: () => void }) {
  return (
    <div className="boundary">
      <div className="boundary-card" role="alert">
        <p className="eyebrow">Something went wrong</p>
        <h1>This page didn’t load</h1>
        <p>
          The workspace couldn’t finish loading this view. Nothing you were working on has been
          changed. Trying again usually clears it.
        </p>
        <div className="boundary-actions">
          <button type="button" className="primary-button" onClick={() => retry()}>
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
