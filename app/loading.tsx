/**
 * The public loading boundary (GRA-06), paired with `app/error.tsx` and
 * covering the same segments: the landing page, the canonical `/schedule` and
 * `/speakers`, the `/embed/*` fragments, the public CFP pages and `/login`.
 * The workspace group has its own shell-preserving fallback in
 * `app/(app)/loading.tsx`, which takes precedence for every page below it.
 *
 * Kept to plain placeholder bars for the same reason as the error boundary:
 * this markup can be painted inside an iframe on a host page, so it brings no
 * header, no nav and nothing that would claim to be a site it is not.
 */
export default function PublicLoading() {
  return (
    <main className="boundary boundary-standalone" style={{ alignItems: "flex-start" }}>
      <div className="skeleton-stack" role="status" aria-live="polite" aria-busy="true">
        <span className="sr-only">Loading…</span>
        <div className="skeleton-panel" aria-hidden="true">
          <div className="skeleton-bar is-title" />
          <div className="skeleton-bar is-lede" />
          <div className="skeleton-bar" />
          <div className="skeleton-bar" />
        </div>
      </div>
    </main>
  );
}
