/**
 * Public schedule embed.
 *
 * Server-rendered on purpose: day tabs, the track filter and keyword search are
 * links and a GET form, so the whole surface works with JavaScript disabled,
 * inside a sandboxed iframe, and produces shareable URLs. Expansion uses native
 * <details>, which needs no hydration either. All filter arithmetic lives in
 * lib/embed-schedule-view.ts so it can be unit-tested without a DOM.
 */
import Link from "next/link";
import { CalendarDays, CalendarPlus, Download, MapPin, Search, User } from "lucide-react";
import type { PublicAgenda } from "@/lib/data/reads";
import { calendarExportUrl } from "@/lib/ics-embed";
import { formatDayLabel, formatEventDateRange, formatTime, zonedParts } from "@/lib/tz";
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

function SessionCard({
  session,
  eventId,
  timeZone,
}: {
  session: ScheduleViewSession;
  eventId: string;
  timeZone: string;
}) {
  const chips = sessionChips(session);
  const split = descriptionPreview(session.description);
  const when = `${formatTime(session.startsAt, timeZone)}–${formatTime(session.endsAt, timeZone)}`;

  return (
    <article className="embed-session" id={`session-${session.sessionId}`} style={{ marginTop: 8 }}>
      <span className="rail" style={{ background: session.track?.color ?? "#687276" }} aria-hidden="true" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <h3>{session.title}</h3>
        <div className="meta">
          {session.speakers.length > 0 && (
            <span className="row" style={{ gap: 4 }}><User size={13} aria-hidden="true" /> {session.speakers.join(", ")}</span>
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
            {session.description ? <p className="embed-session-desc">{session.description}</p> : null}
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
                  <dd>{session.speakers.join(", ")}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        </details>

        <a
          className="ghost-button ics-button"
          href={calendarExportUrl(eventId, session.sessionId)}
          style={{ textDecoration: "none" }}
        >
          <Download size={14} /> Add to calendar
        </a>
      </div>
    </article>
  );
}

export function EmbedSchedule({
  agenda,
  eventParam,
  searchParams = {},
}: {
  agenda: PublicAgenda;
  /** Echoed into every generated link exactly as the host page supplied it. */
  eventParam?: string;
  searchParams?: { track?: string; day?: string; q?: string };
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
  const isFiltered = filters.track !== ALL || filters.day !== ALL || filters.q !== "";
  const href = (overrides: Partial<typeof filters>) => scheduleHref(eventParam, filters, overrides);
  const selectedDayLabel = tabs.find((tab) => tab.current)?.label ?? null;

  return (
    <div className="embed-page">
      <header className="embed-header">
        <div className="row wrap" style={{ justifyContent: "space-between", gap: 12 }}>
          <div>
            <h1>{agenda.event.name}</h1>
            <p className="hint">
              {resultSummary(agenda.sessions.length, filtered.length, isFiltered, agenda.truncated ?? false)}
              {dateRange ? ` · ${dateRange}` : ""}
            </p>
            {/* A reader whose programme was cut short is told, rather than
                shown a confident count of a partial schedule (S20). */}
            {agendaTruncationNotice(agenda) ? (
              <p className="hint" role="status">{agendaTruncationNotice(agenda)}</p>
            ) : null}
          </div>
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

        {/* A plain GET form: submitting works without JavaScript and the result
            is a linkable URL. Hidden inputs keep the other filters intact. */}
        <form className="embed-search-form" method="get" action="/embed/schedule" role="search">
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
            <Link className="ghost-button" href={scheduleHref(eventParam, { track: ALL, day: ALL, q: "" })} prefetch={false}>
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
      </header>

      {/* <main> (not <div>) so the embed exposes a landmark, matching
          embed-speakers.tsx — closes the Lighthouse a11y finding. */}
      <main className="embed-body">
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
            <Link className="ghost-button" href={scheduleHref(eventParam, { track: ALL, day: ALL, q: "" })} prefetch={false}>
              Show the full schedule
            </Link>
          </div>
        ) : (
          days.map(([dayKey, items]) => (
            <section key={dayKey}>
              <h2 className="time-heading" style={{ fontSize: 13 }}>{formatDayLabel(dayKey, tz)}</h2>
              {items.map((s) => (
                <SessionCard key={s.slotId} session={s} eventId={agenda.event.id} timeZone={tz} />
              ))}
            </section>
          ))
        )}
      </main>
    </div>
  );
}
