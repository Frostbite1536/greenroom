import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, CalendarDays, Mic2, Users } from "lucide-react";
import { getResolvedSession, homeForRole } from "@/lib/auth";
import { getPublicAgenda } from "@/lib/data/reads";
import { DEFAULT_PUBLIC_EVENT, getOpenCfpEntry } from "@/lib/data/open-cfp";
import {
  CANONICAL_SCHEDULE_PATH,
  CANONICAL_SPEAKERS_PATH,
  EMBED_SCHEDULE_PATH,
  EMBED_SPEAKERS_PATH,
  publicSurfaceUrl,
} from "@/lib/embed-alias";
import { boundedCount, derivedBoundedCount } from "@/lib/bounded-count";
import { normalizeLandingEventParam, resolveLandingEvent } from "@/lib/landing-event";
import { OpenCfpEntryPanel } from "@/components/open-cfp-entry";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ event?: string }>;

/**
 * Resolve the programme ONCE, for the page and its metadata alike.
 *
 * An explicit `?event=` is honoured only when it resolves; a blank or unknown
 * slug behaves exactly like no slug, so the agenda, the metrics, the open-CFP
 * entry, the embed links, and the metadata all describe the same event. Reads
 * are `cache()`-deduplicated, so calling this from both entry points costs one
 * lookup per distinct event.
 */
async function loadLandingProgramme(searchParams: SearchParams) {
  const { event } = await searchParams;
  const requested = normalizeLandingEventParam(event);
  const requestedAgenda = requested ? await getPublicAgenda(requested) : null;
  const resolution = resolveLandingEvent(requested, requestedAgenda !== null);
  const agenda = requestedAgenda ?? (await getPublicAgenda(DEFAULT_PUBLIC_EVENT));
  return { resolution, agenda };
}

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }) {
  const { agenda } = await loadLandingProgramme(searchParams);
  return {
    title: agenda ? agenda.event.name : "Conference program",
    description: agenda
      ? `Schedule, speakers, and the call for proposals for ${agenda.event.name}.`
      : "Schedule, speakers, and the call for proposals.",
  };
}

/** Event dates in the event's own timezone, pinned to en-US like the embeds. */
function formatEventDates(
  startsAt: string | null,
  endsAt: string | null,
  timeZone: string,
): string | null {
  if (!startsAt) return null;
  const format = (iso: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(new Date(iso));
  const start = format(startsAt);
  if (!endsAt) return start;
  const end = format(endsAt);
  return start === end ? start : `${start} – ${end}`;
}

/**
 * Public landing page.
 *
 * A logged-out visitor used to be bounced straight to `/login`, which hid the
 * whole public programme behind a sign-in wall. `/` is now the front door: it
 * presents the event and links the public schedule, the public speaker
 * directory, and the open call for proposals. Signed-in users keep their
 * existing behaviour and go straight to their workspace.
 */
export default async function HomePage({ searchParams }: { searchParams: SearchParams }) {
  const session = await getResolvedSession();
  if (session) redirect(homeForRole(session.role));

  const { resolution, agenda } = await loadLandingProgramme(searchParams);
  // Keyed off the RESOLVED programme, never off the requested slug: the CFP
  // entry can only ever describe the event whose schedule this page is showing.
  const openCfp = await getOpenCfpEntry(agenda?.event.slug ?? DEFAULT_PUBLIC_EVENT);

  const timezone = agenda?.event.timezone ?? "UTC";
  const eventName = agenda?.event.name ?? openCfp.event?.name ?? null;
  const dates = agenda ? formatEventDates(agenda.event.startsAt, agenda.event.endsAt, timezone) : null;
  const sessionCount = agenda?.sessions.length ?? 0;
  const speakerCount = agenda ? new Set(agenda.sessions.flatMap((s) => s.speakers)).size : 0;
  const trackCount = agenda?.tracks.length ?? 0;
  // The session read is capped, so both counts derived from it are floors past
  // the cap. Taken from the read's own flag rather than a second `count()`:
  // one read, one truth (the email-history rule).
  const programmeTruncated = agenda?.truncated ?? false;

  // The hero links now point at the canonical pages a visitor can share and a
  // crawler can index; the panel below still advertises the `/embed/*` variants
  // because those are the URLs an organizer pastes into an iframe.
  const schedulePath = publicSurfaceUrl(CANONICAL_SCHEDULE_PATH, resolution.eventParam);
  const speakersPath = publicSurfaceUrl(CANONICAL_SPEAKERS_PATH, resolution.eventParam);

  return (
    <main className="landing">
      <div className="landing-shell">
        <header className="landing-head">
          <p className="landing-brand">
            <span className="brand-mark" aria-hidden="true"><Mic2 size={18} /></span>
            <span>Greenroom</span>
          </p>
          <Link className="landing-signin" href="/login">Organizer sign in</Link>
        </header>

        <section className="landing-hero">
          {dates ? <p className="eyebrow">{dates}</p> : null}
          <h1>{eventName ?? "Conference program"}</h1>
          <p className="landing-lede">
            {eventName
              ? `Browse the full ${eventName} schedule, meet the speakers, and submit a talk.`
              : "Browse the schedule, meet the speakers, and submit a talk."}
          </p>
          <div className="landing-actions">
            <Link className="landing-cta" href={schedulePath}>
              <CalendarDays size={17} aria-hidden="true" />
              <span>View the schedule</span>
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
            <Link className="landing-cta landing-cta-secondary" href={speakersPath}>
              <Users size={17} aria-hidden="true" />
              <span>Meet the speakers</span>
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </div>
        </section>

        {agenda ? (
          <>
            <div className="metric-grid landing-metrics">
              {/* Both of these are counted off the capped session read, so past
                  the cap they are floors and say so. `Tracks` comes from its
                  own uncapped read and stays an exact number. */}
              <div className="metric">
                <span>Scheduled sessions</span>
                <strong>{boundedCount(sessionCount, programmeTruncated)}</strong>
              </div>
              <div className="metric">
                <span>Speakers</span>
                <strong>{derivedBoundedCount(speakerCount, programmeTruncated)}</strong>
              </div>
              <div className="metric"><span>Tracks</span><strong>{trackCount}</strong></div>
            </div>
            {programmeTruncated ? (
              <p className="landing-notice">
                This program is larger than this page counts at once, so the session and speaker
                figures above are the minimum. Open the full schedule to see everything.
              </p>
            ) : null}
          </>
        ) : (
          <p className="landing-notice">
            No public program is published yet. The schedule and speaker directory
            appear here once the program is announced.
          </p>
        )}

        <div className="landing-grid">
          <OpenCfpEntryPanel entry={openCfp} id="landing-open-cfp" />

          <section className="landing-panel" aria-labelledby="landing-public-pages">
            <h2 className="landing-panel-heading" id="landing-public-pages">Public pages</h2>
            <p className="landing-panel-lede">
              The program lives at these URLs and needs no sign-in. The
              <code> /embed/</code> variants are the same pages without this
              header, for an iframe on your own site.
            </p>
            <ul className="landing-links">
              <li>
                <Link href={CANONICAL_SCHEDULE_PATH}>{CANONICAL_SCHEDULE_PATH}</Link>
                <span>Every scheduled session, by day, room, and track.</span>
              </li>
              <li>
                <Link href={CANONICAL_SPEAKERS_PATH}>{CANONICAL_SPEAKERS_PATH}</Link>
                <span>The confirmed speaker directory with their sessions.</span>
              </li>
              <li>
                <Link href={EMBED_SCHEDULE_PATH}>{EMBED_SCHEDULE_PATH}</Link>
                <span>The schedule, chrome-free, for embedding in an iframe.</span>
              </li>
              <li>
                <Link href={EMBED_SPEAKERS_PATH}>{EMBED_SPEAKERS_PATH}</Link>
                <span>The speaker directory, chrome-free, for the same.</span>
              </li>
            </ul>
          </section>
        </div>

        <footer className="landing-foot">
          <p>
            {eventName ? `${eventName} · ` : ""}Program operations run on Greenroom.
          </p>
        </footer>
      </div>
    </main>
  );
}
