/**
 * The standalone chrome around the canonical `/schedule` and `/speakers` pages.
 *
 * Deliberately minimal, and deliberately the landing page's own header pattern
 * (`landing-head` / `landing-brand` / `landing-signin` from app/globals.css)
 * rather than a second visual language: a visitor moving from `/` to
 * `/schedule` should not feel they have left the site.
 *
 * The `/embed/*` variant renders none of this — that is the entire difference
 * between the two surfaces. Everything here is links and static markup, so the
 * canonical pages stay as server-rendered and JavaScript-free as the embeds.
 */
import Link from "next/link";
import { Mic2 } from "lucide-react";
import { API_DOCS_PATH } from "@/lib/api/openapi";
import {
  CANONICAL_SCHEDULE_PATH,
  CANONICAL_SPEAKERS_PATH,
  publicSurfaceUrl,
} from "@/lib/embed-alias";

export function PublicChrome({
  eventParam,
  active,
  children,
}: {
  /** Echoed onto every nav link exactly as it arrived, so `?event=` survives. */
  eventParam?: string;
  active: "schedule" | "speakers" | "api";
  children: React.ReactNode;
}) {
  return (
    <main className="landing public-programme">
      <div className="landing-shell">
        <header className="landing-head">
          <p className="landing-brand">
            <Link href={publicSurfaceUrl(CANONICAL_SCHEDULE_PATH, eventParam)}>
              <span className="brand-mark" aria-hidden="true"><Mic2 size={18} /></span>
              <span>Greenroom</span>
            </Link>
          </p>
          <nav className="public-programme-nav" aria-label="Public program">
            <Link
              className="landing-signin"
              href={publicSurfaceUrl(CANONICAL_SCHEDULE_PATH, eventParam)}
              aria-current={active === "schedule" ? "page" : undefined}
            >
              Schedule
            </Link>
            <Link
              className="landing-signin"
              href={publicSurfaceUrl(CANONICAL_SPEAKERS_PATH, eventParam)}
              aria-current={active === "speakers" ? "page" : undefined}
            >
              Speakers
            </Link>
            {/* The API contract is a public page like the two above it: no key,
                no programme data, and nothing to configure before reading it. */}
            <Link
              className="landing-signin"
              href={API_DOCS_PATH}
              aria-current={active === "api" ? "page" : undefined}
            >
              API
            </Link>
            <Link className="landing-signin" href="/login">Organizer sign in</Link>
          </nav>
        </header>

        <div className="public-programme-body">{children}</div>
      </div>
    </main>
  );
}
