"use client";

/**
 * The public boundary (GRA-06): everything outside the workspace group —
 * `/`, `/schedule`, `/speakers`, `/embed/schedule`, `/embed/speakers`, the
 * public CFP pages, `/login` and the reviewer-invite landing.
 *
 * One boundary at the closest shared segment rather than five near-identical
 * files. That means it renders both standalone and inside an `/embed/*` iframe
 * on someone else's site, so it carries no nav, no brand lockup and no link
 * back — chrome that would be wrong in a frame — just the honest statement and
 * the retry. The root `layout.tsx` is above this boundary and cannot be caught
 * here; that would need `global-error.tsx`, which is out of scope.
 *
 * `retry()` re-fetches the segment (see the note in `app/(app)/error.tsx`).
 */
export default function PublicError({ retry }: { retry: () => void }) {
  return (
    <main className="boundary boundary-standalone">
      <div className="boundary-card" role="alert">
        <p className="eyebrow">Something went wrong</p>
        <h1>This page didn’t load</h1>
        <p>
          We couldn’t load this part of the program just now. It’s not something you did — please
          try again in a moment.
        </p>
        <div className="boundary-actions">
          <button type="button" className="primary-button" onClick={() => retry()}>
            Try again
          </button>
        </div>
      </div>
    </main>
  );
}
