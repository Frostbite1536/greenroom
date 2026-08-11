/**
 * The workspace not-found boundary (GRA-06). It renders below
 * `app/(app)/layout.tsx`, so an organizer who follows a stale link — a deleted
 * form, a removed resource, a task or evaluation plan that no longer exists —
 * keeps the shell and its full navigation, instead of landing on a chrome-free
 * 404 with no way back.
 *
 * No "go home" button on purpose: the sidebar beside this card is already the
 * role-correct navigation, and a hard-coded destination here would be a dead
 * link for whichever role it did not match.
 */
export default function WorkspaceNotFound() {
  return (
    <div className="boundary">
      <div className="boundary-card">
        <p className="eyebrow">Not found</p>
        <h1>We couldn’t find that</h1>
        <p>
          It may have been deleted, or it may belong to a different event. Everything else in this
          workspace is unaffected — pick up from the menu on the left.
        </p>
      </div>
    </div>
  );
}
