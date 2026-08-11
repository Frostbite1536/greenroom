import Link from "next/link";
import { CANONICAL_SCHEDULE_PATH } from "@/lib/embed-alias";

/**
 * The public not-found boundary (GRA-06). Reached by an unmatched URL and by
 * every `notFound()` outside the workspace group — an unknown event slug or
 * form slug on the public CFP, and a programme surface with no published
 * agenda. Without this file all of those fell to Next's default 404, which
 * renders its own document and does not follow the app's styles at all.
 *
 * A server component: nothing here is interactive.
 */
export default function PublicNotFound() {
  return (
    <main className="boundary boundary-standalone">
      <div className="boundary-card">
        <p className="eyebrow">Not found</p>
        <h1>We couldn’t find that page</h1>
        <p>
          The link may be out of date, or the page may have moved. The published programme is
          always available from the schedule.
        </p>
        <div className="boundary-actions">
          <Link className="boundary-link" href={CANONICAL_SCHEDULE_PATH}>
            View the schedule
          </Link>
          <Link className="boundary-link" href="/">
            Go to the home page
          </Link>
        </div>
      </div>
    </main>
  );
}
