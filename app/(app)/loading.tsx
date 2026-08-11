/**
 * Workspace loading boundary (GRA-06).
 *
 * `app/(app)/layout.tsx` renders the shell, and this Suspense fallback sits
 * *inside* it, so the sidebar, topbar and event switcher stay put and only the
 * content area swaps — a navigation reads as the same page filling in rather
 * than a blank screen. The shapes deliberately echo the panels most workspace
 * pages open with (header, then a metric row, then a work panel) so nothing
 * jumps when the real content arrives.
 *
 * A server component: it holds no state and must not cost a client bundle.
 */
export default function WorkspaceLoading() {
  return (
    <div className="skeleton-stack" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div aria-hidden="true" style={{ display: "grid", gap: 10 }}>
        <div className="skeleton-bar is-title" />
        <div className="skeleton-bar is-lede" />
      </div>
      <div className="skeleton-panel" aria-hidden="true">
        <div className="skeleton-bar is-short" />
        <div className="skeleton-bar" />
        <div className="skeleton-bar" />
      </div>
      <div className="skeleton-panel" aria-hidden="true">
        <div className="skeleton-bar is-short" />
        <div className="skeleton-bar" />
        <div className="skeleton-bar" />
        <div className="skeleton-bar" />
      </div>
    </div>
  );
}
