/**
 * Public schedule embed.
 *
 * Server-rendered on purpose: day tabs, the track filter and keyword search are
 * links and a GET form, so the whole surface works with JavaScript disabled,
 * inside a sandboxed iframe, and produces shareable URLs. Expansion uses native
 * <details>, which needs no hydration either. All filter arithmetic lives in
 * lib/embed-schedule-view.ts so it can be unit-tested without a DOM.
 *
 * The one exception is "My itinerary" (components/schedule-itinerary.tsx): there
 * are no attendee accounts, so a starred set can only live in the reader's own
 * browser, which nothing on the server can know. It is three small leaves —
 * a star per card, one filter beside the day tabs, and a wrapper that swaps the
 * server-rendered day sections for the reader's list — and every one of them
 * renders nothing until it hydrates, so this page with JavaScript disabled is
 * exactly the page it was before the feature existed.
 */
import Link from "next/link";
import { CalendarDays, CalendarPlus, Download, MapPin, Search, User, Users } from "lucide-react";
import type { PublicAgenda } from "@/lib/data/reads";
import { calendarExportUrl } from "@/lib/ics-embed";
import {
  EMBED_SCHEDULE_PATH,
  EMBED_SPEAKERS_PATH,
  publicSurfaceUrl,
  type PublicSurfacePath,
} from "@/lib/embed-alias";
import { speakerAnchorHref } from "@/lib/speaker-anchor";
import { PUBLIC_SESSION_SUMMARY_FALLBACK } from "@/lib/public-session-copy";
import { formatDayLabel, formatEventDateRange, formatTimeRange, timeZoneNote, zonedParts } from "@/lib/tz";
import {
  ALL,
  agendaTruncationNotice,
  chipPrefix,
  dayTabs,
  descriptionPreview,
  eventDayKeys,
  filterSessions,
  groupByDay,
  resolveDay,
  resolveQuery,
  resolveTrack,
  resultSummary,
  scheduleHref,
  sessionChips,
  type ScheduleViewSession,
} from "@/lib/embed-schedule-view";
import { EmptyState } from "@/components/ui";
import { ItineraryStar, ItineraryTab, ItineraryView } from "@/components/schedule-itinerary";
import type { ItinerarySession } from "@/lib/itinerary";

/** Slim, description-free projection the itinerary island renders rows from. */
function itineraryProjection(session: ScheduleViewSession): ItinerarySession {
  return {
    sessionId: session.sessionId,
    title: session.title,
    startsAt: session.startsAt,
    endsAt: session.endsAt,
    roomName: session.room.name,
    trackName: session.track?.name ?? null,
    trackColor: session.track?.color ?? null,
  };
}

function SessionCard({
  session,
  eventId,
  eventKey,
  timeZone,
  speakersUrl,
}: {
  session: ScheduleViewSession;
  eventId: string;
  /** Namespaces this reader's starred set; the event as the page resolved it. */
  eventKey: string;
  timeZone: string;
  /** The speaker directory on this same surface, for the name cross-links. */
  speakersUrl: string;
}) {
  const chips = sessionChips(session);
  const split = descriptionPreview(session.description);
  // Labelled with the event's zone at this session's own instant, so a reader
  // outside the venue's timezone is never left guessing which clock (§5-2).
  const when = formatTimeRange(session.startsAt, session.endsAt, timeZone);

  return (
    <article className="embed-session" id={`session-${session.sessionId}`} style={{ marginTop: 8 }}>
      <span className="rail" style={{ background: session.track?.color ?? "#687276" }} aria-hidden="true" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <h3>{session.title}</h3>
        <div className="meta">
          {session.speakers.length > 0 && (
            <span className="row" style={{ gap: 4 }}>
              <User size={13} aria-hidden="true" />{" "}
              {/* Each name links to its own card on the speaker directory, so
                  the session -> speaker direction finally exists (§5-3). */}
              {session.speakers.map((name, index) => (
                <span key={name}>
                  {index > 0 ? ", " : ""}
                  <Link className="embed-speaker-link" href={speakerAnchorHref(speakersUrl, name)} prefetch={false}>
                    {name}
                  </Link>
                </span>
              ))}
            </span>
          )}
          <span className="row" style={{ gap: 4 }}><MapPin size={13} aria-hidden="true" /> {session.room.name}</span>
          <span>{when}</span>
        </div>

        {/* Format / track / topic / room as readable text, so the label never
            depends on the colour rail alone. */}
        <ul className="embed-chips">
          {chips.map((chip) => (
            <li className={`embed-chip embed-chip-${chip.kind}`} key={`${chip.kind}-${chip.label}`}>
              <span className="sr-only">{chipPrefix(chip.kind)}: </span>
              {chip.label}
            </li>
          ))}
        </ul>

        {split && !split.truncated ? <p className="embed-session-desc">{split.preview}</p> : null}

        <details className="embed-session-detail">
          <summary>
            {split?.truncated ? (
              <span className="embed-session-preview">{split.preview}…</span>
            ) : null}
            <span className="embed-more">
              <span className="embed-more-closed">{split?.truncated ? "Show more" : "Session details"}</span>
              <span className="embed-more-open">{split?.truncated ? "Show less" : "Hide details"}</span>
            </span>
          </summary>
          <div className="embed-session-full">
            {/* An honest sentence about the absence, never the operational note
                that used to sit in this column (§5-4). `session.description` is
                already sanitized by the read, so `null` here means "genuinely
                unpublished", not "internal text suppressed". */}
            <p className="embed-session-desc">
              {session.description ?? PUBLIC_SESSION_SUMMARY_FALLBACK}
            </p>
            <dl className="embed-session-facts">
              <div>
                <dt>When</dt>
                {/* The event-local day, not the UTC one: a 6pm Pacific session
                    starts on the following UTC date. */}
                <dd>{formatDayLabel(zonedParts(session.startsAt, timeZone).dateKey, timeZone)}, {when}</dd>
              </div>
              <div>
                <dt>Room</dt>
                <dd>{session.room.name}</dd>
              </div>
              {session.format ? (
                <div>
                  <dt>Format</dt>
                  <dd>{session.format}</dd>
                </div>
              ) : null}
              {session.track ? (
                <div>
                  <dt>Track</dt>
                  <dd>{session.track.name}</dd>
                </div>
              ) : null}
              {session.category ? (
                <div>
                  <dt>Topic</dt>
                  <dd>{session.category.name}</dd>
                </div>
              ) : null}
              {session.speakers.length > 0 ? (
                <div>
                  <dt>{session.speakers.length === 1 ? "Speaker" : "Speakers"}</dt>
                  <dd>
                    {session.speakers.map((name, index) => (
                      <span key={name}>
                        {index > 0 ? ", " : ""}
                        <Link className="embed-speaker-link" href={speakerAnchorHref(speakersUrl, name)} prefetch={false}>
                          {name}
                        </Link>
                      </span>
                    ))}
                  </dd>
                </div>
              ) : null}
            </dl>
          </div>
        </details>

        {/* The only client-side thing on the card, and the only one on the page
            besides the itinerary tab and view. Everything above is server HTML. */}
        <div className="embed-session-actions">
          <a
            className="ghost-button"
            href={calendarExportUrl(eventId, session.sessionId)}
            style={{ textDecoration: "none" }}
          >
            <Download size={14} /> Add to calendar
          </a>
          <ItineraryStar eventKey={eventKey} sessionId={session.sessionId} title={session.title} />
        </div>
      </div>
    </article>
  );
}

export function EmbedSchedule({
  agenda,
  eventParam,
  searchParams = {},
  basePath = EMBED_SCHEDULE_PATH,
  speakersPath = EMBED_SPEAKERS_PATH,
}: {
  agenda: PublicAgenda;
  /** Echoed into every generated link exactly as the host page supplied it. */
  eventParam?: string;
  searchParams?: { track?: string; day?: string; q?: string };
  /** Where this page's own filter links and search form return to: the
   *  canonical `/schedule` or the frameable `/embed/schedule`. */
  basePath?: PublicSurfacePath;
  /** The speaker directory on the SAME surface: a framed reader must not be
   *  navigated onto the standalone site, nor the reverse. */
  speakersPath?: PublicSurfacePath;
}) {
  const tz = agenda.event.timezone;
  const dayKeys = eventDayKeys(agenda);
  const filters = {
    track: resolveTrack(agenda, searchParams.track),
    day: resolveDay(dayKeys, searchParams.day),
    q: resolveQuery(searchParams.q),
  };
  const filtered = filterSessions(agenda, filters);
  const tabs = dayTabs(agenda, filters, formatDayLabel);
  const days = groupByDay(filtered, tz);
  const dateRange = formatEventDateRange(agenda.event.startsAt, agenda.event.endsAt, tz);
  // Derived from real instants, not render time, so a summer programme read in
  // winter still says PDT. The whole programme is offered — not just the event
  // bounds — because a card labels its own instant, and a programme spanning a
  // DST change must not be given a header claiming a single abbreviation that
  // half its cards contradict. `agenda.sessions`, not `filtered`: the note
  // describes the page's clock, which must not change as the reader filters.
  const zoneNote = timeZoneNote(tz, [
    agenda.event.startsAt,
    agenda.event.endsAt,
    ...agenda.sessions.flatMap((session) => [session.startsAt, session.endsAt]),
  ]);
  const isFiltered = filters.track !== ALL || filters.day !== ALL || filters.q !== "";
  const href = (overrides: Partial<typeof filters>) => scheduleHref(eventParam, filters, overrides, basePath);
  const selectedDayLabel = tabs.find((tab) => tab.current)?.label ?? null;
  const speakersUrl = publicSurfaceUrl(speakersPath, eventParam ?? agenda.event.slug);
  // The itinerary's localStorage namespace. The resolved slug, not `eventParam`:
  // a host page linking the same programme by id and by slug must not give one
  // reader two different starred sets.
  const itineraryKey = agenda.event.slug;
  // Every published, placed session — not `filtered`: the itinerary spans the
  // whole programme, so a starred talk must not vanish from it because the
  // reader has a day tab or a search term active.
  const itineraryData = agenda.sessions.map(itineraryProjection);

  return (
    <div className="embed-page">
      <header className="embed-header">
        <div className="row wrap" style={{ justifyContent: "space-between", gap: 12 }}>
          <div>
            <h1>{agenda.event.name}</h1>
            <p className="hint">
              {resultSummary(agenda.sessions.length, filtered.length, isFiltered, agenda.truncated ?? false)}
              {dateRange ? ` · ${dateRange}` : ""}
              {` · ${zoneNote}`}
            </p>
            {/* A reader whose programme was cut short is told, rather than
                shown a confident count of a partial schedule (S20). */}
            {agendaTruncationNotice(agenda) ? (
              <p className="hint" role="status">{agendaTruncationNotice(agenda)}</p>
            ) : null}
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            {/* The reverse of the gallery's own "Schedule" link, so the two
                public pages are reachable from each other (§5-3). */}
            <Link className="ghost-button" href={speakersUrl} prefetch={false}>
              <Users size={15} aria-hidden="true" /> Speakers
            </Link>
            {agenda.sessions.length > 0 && (
              <a
                className="ghost-button"
                href={calendarExportUrl(agenda.event.id)}
                style={{ textDecoration: "none" }}
              >
                <CalendarPlus size={15} /> Add all to calendar
              </a>
            )}
          </div>
        </div>

        {/* A plain GET form: submitting works without JavaScript and the result
            is a linkable URL. Hidden inputs keep the other filters intact. */}
        <form className="embed-search-form" method="get" action={basePath} role="search">
          {eventParam ? <input type="hidden" name="event" value={eventParam} /> : null}
          {filters.track !== ALL ? <input type="hidden" name="track" value={filters.track} /> : null}
          {filters.day !== ALL ? <input type="hidden" name="day" value={filters.day} /> : null}
          <label className="embed-search">
            <span className="sr-only">Search sessions by title, speaker or description</span>
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              name="q"
              defaultValue={filters.q}
              autoComplete="off"
              placeholder="Search sessions, speakers, topics…"
            />
          </label>
          <button className="ghost-button" type="submit">Search</button>
          {isFiltered ? (
            <Link className="ghost-button" href={scheduleHref(eventParam, { track: ALL, day: ALL, q: "" }, {}, basePath)} prefetch={false}>
              Clear
            </Link>
          ) : null}
        </form>

        {tabs.length > 1 && (
          <nav className="embed-filters embed-daytabs" aria-label="Filter by day">
            <Link
              className="ghost-button"
              href={href({ day: ALL })}
              aria-current={filters.day === ALL ? "page" : undefined}
              prefetch={false}
            >
              All days
            </Link>
            {tabs.map((tab) => (
              <Link
                className="ghost-button"
                key={tab.key}
                href={href({ day: tab.key })}
                aria-current={tab.current ? "page" : undefined}
                prefetch={false}
              >
                {/* One interpolation, not `({tab.count})`: React would split
                    that into three text nodes separated by HTML comments, which
                    breaks plain-markup assertions on the count. */}
                {tab.label} <span className="embed-tab-count">{`(${tab.count})`}</span>
              </Link>
            ))}
          </nav>
        )}

        {agenda.tracks.length > 0 && (
          <nav className="embed-filters" aria-label="Filter by track">
            <Link
              className="ghost-button"
              href={href({ track: ALL })}
              aria-current={filters.track === ALL ? "true" : undefined}
              prefetch={false}
            >
              All tracks
            </Link>
            {agenda.tracks.map((t) => (
              <Link
                className="ghost-button"
                key={t.id}
                href={href({ track: t.id })}
                aria-current={filters.track === t.id ? "true" : undefined}
                prefetch={false}
              >
                <span style={{ width: 8, height: 8, borderRadius: 3, background: t.color, display: "inline-block" }} aria-hidden="true" /> {t.name}
              </Link>
            ))}
          </nav>
        )}
        {/* The one interactive filter, beside the server-rendered ones. It draws
            nothing at all until it has hydrated. */}
        <ItineraryTab eventKey={itineraryKey} />
      </header>

      {/* <main> (not <div>) so the embed exposes a landmark, matching
          embed-speakers.tsx — closes the Lighthouse a11y finding. */}
      <main className="embed-body">
        <ItineraryView
          eventKey={itineraryKey}
          eventId={agenda.event.id}
          timeZone={tz}
          sessions={itineraryData}
        >
        {agenda.sessions.length === 0 ? (
          <EmptyState icon={<CalendarDays size={22} />} title="Schedule coming soon">
            Sessions will appear here once the agenda is published.
          </EmptyState>
        ) : filtered.length === 0 ? (
          <div className="embed-empty">
            <EmptyState
              icon={<CalendarDays size={22} />}
              title={selectedDayLabel && !filters.q && filters.track === ALL
                ? `Nothing scheduled on ${selectedDayLabel} yet`
                : "No sessions match those filters"}
            >
              {selectedDayLabel && !filters.q && filters.track === ALL
                ? "This day is part of the event but has no published sessions yet."
                : "Try another day, track, or search term."}
            </EmptyState>
            <Link className="ghost-button" href={scheduleHref(eventParam, { track: ALL, day: ALL, q: "" }, {}, basePath)} prefetch={false}>
              Show the full schedule
            </Link>
          </div>
        ) : (
          days.map(([dayKey, items]) => (
            <section key={dayKey}>
              <h2 className="time-heading" style={{ fontSize: 13 }}>{formatDayLabel(dayKey, tz)}</h2>
              {items.map((s) => (
                <SessionCard
                  key={s.slotId}
                  session={s}
                  eventId={agenda.event.id}
                  eventKey={itineraryKey}
                  timeZone={tz}
                  speakersUrl={speakersUrl}
                />
              ))}
            </section>
          ))
        )}
        </ItineraryView>
      </main>
    </div>
  );
}
