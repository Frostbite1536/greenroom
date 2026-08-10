"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CalendarDays, Mic2, Search, Users } from "lucide-react";
import type { PublicSpeaker, PublicSpeakers } from "@/lib/public-speakers";
import { formatEventDateRange } from "@/lib/tz";
import { boundedCountLabel } from "@/lib/bounded-count";
import {
  headshotAlt,
  initials,
  sessionPlacementLine,
  speakerDetailLine,
} from "@/lib/embed-speaker-view";
import { EmptyState } from "@/components/ui";

export function EmbedSpeakers({
  gallery,
  initialQuery,
  initialTrack,
}: {
  gallery: PublicSpeakers;
  initialQuery: string;
  initialTrack: string;
}) {
  const isKnownTrack = (value: string) => value === "all" || gallery.tracks.some((item) => item.name === value);
  const [query, setQuery] = useState(initialQuery);
  const [track, setTrack] = useState(isKnownTrack(initialTrack) ? initialTrack : "all");
  const normalizedQuery = query.trim().toLocaleLowerCase();

  useEffect(() => {
    const restoreFilters = () => {
      const params = new URLSearchParams(window.location.search);
      const nextTrack = params.get("track") ?? "all";
      setQuery(params.get("q") ?? "");
      setTrack(isKnownTrack(nextTrack) ? nextTrack : "all");
    };
    window.addEventListener("popstate", restoreFilters);
    return () => window.removeEventListener("popstate", restoreFilters);
  }, [gallery.tracks]);

  const filtered = useMemo(
    () => gallery.speakers.filter((speaker) => {
      const matchesTrack = track === "all" || speaker.sessions.some((session) => session.track?.name === track);
      if (!matchesTrack) return false;
      if (!normalizedQuery) return true;
      return [
        speaker.name,
        speaker.company,
        speaker.jobTitle,
        speaker.bio,
        ...speaker.sessions.map((session) => session.title),
      ]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    }),
    [gallery.speakers, normalizedQuery, track],
  );

  const scheduleUrl = `/embed/schedule?event=${encodeURIComponent(gallery.event.slug)}`;
  const dates = formatEventDateRange(gallery.event.startsAt, gallery.event.endsAt, gallery.event.timezone);

  const updateUrl = (nextQuery: string, nextTrack: string, historyMode: "push" | "replace") => {
    const url = new URL(window.location.href);
    if (nextQuery.trim()) url.searchParams.set("q", nextQuery);
    else url.searchParams.delete("q");
    if (nextTrack !== "all") url.searchParams.set("track", nextTrack);
    else url.searchParams.delete("track");
    if (historyMode === "push") window.history.pushState(window.history.state, "", url);
    else window.history.replaceState(window.history.state, "", url);
  };

  const selectTrack = (nextTrack: string) => {
    setTrack(nextTrack);
    updateUrl(query, nextTrack, "push");
  };

  const clearFilters = () => {
    setQuery("");
    setTrack("all");
    updateUrl("", "all", "push");
  };

  return (
    <div className="embed-page speaker-embed-page">
      <header className="embed-header speaker-embed-header">
        <div className="embed-header-inner">
          <div className="row wrap speaker-embed-heading">
            <div>
              <h1>{gallery.event.name}</h1>
              <p className="hint">
                {/* A floor, not a total, once the read was capped — the note
                    below says so in words, and this must not contradict it. */}
                {boundedCountLabel(gallery.speakers.length, gallery.truncated, "speaker")}
                {dates ? ` · ${dates}` : ""}
              </p>
            </div>
            <Link className="ghost-button" href={scheduleUrl}>
              <CalendarDays size={15} aria-hidden="true" /> Schedule
            </Link>
          </div>

          {/* A real GET form so search still works with JavaScript disabled:
              the page already reads `?q=` server-side. With JS the onChange
              filters live and rewrites the URL, and Enter submits the same
              query it would have produced. */}
          <form className="speaker-gallery-controls" method="get" action="/embed/speakers" role="search">
            <input type="hidden" name="event" value={gallery.event.slug} />
            {track !== "all" ? <input type="hidden" name="track" value={track} /> : null}
            <label className="speaker-search">
              <span className="sr-only">Search speakers by name, company, bio or session</span>
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                name="q"
                autoComplete="off"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  updateUrl(event.target.value, track, "replace");
                }}
                placeholder="Search speakers, companies, sessions…"
              />
            </label>
            {gallery.tracks.length > 0 ? (
              <div className="speaker-track-filters" role="group" aria-label="Filter speakers by track">
                <button className="ghost-button" type="button" onClick={() => selectTrack("all")} aria-pressed={track === "all"}>
                  All
                </button>
                {gallery.tracks.map((item) => (
                  <button
                    className="ghost-button"
                    type="button"
                    key={item.name}
                    onClick={() => selectTrack(item.name)}
                    aria-pressed={track === item.name}
                  >
                    {item.name}
                  </button>
                ))}
              </div>
            ) : null}
            <button className="ghost-button speaker-search-submit" type="submit">Search</button>
          </form>
        </div>
      </header>

      <main className="embed-body speaker-embed-body">
        <p className="sr-only" aria-live="polite">{filtered.length} speakers shown</p>
        {gallery.truncated ? (
          <p className="speaker-limit-note">Showing the first {gallery.speakers.length} speakers. Open the schedule for the full program.</p>
        ) : null}
        {gallery.speakers.length === 0 ? (
          <EmptyState icon={<Users size={22} />} title="Speaker lineup coming soon">
            Speakers will appear here once sessions are added to the public schedule.
          </EmptyState>
        ) : filtered.length === 0 ? (
          <div className="speaker-empty-state">
            <EmptyState icon={<Users size={22} />} title="No speakers found">
              Try a different search or track.
            </EmptyState>
            <button className="ghost-button speaker-clear-filters" type="button" onClick={clearFilters}>Clear filters</button>
          </div>
        ) : (
          <div className="speaker-grid">
            {filtered.map((speaker, index) => {
              const detail = speakerDetailLine(speaker);
              const key = `${speaker.name}-${speaker.sessions.map((session) => session.id).join("-")}-${index}`;
              return (
                <article className="speaker-card" key={key}>
                  <div className="speaker-avatar">
                    <span aria-hidden="true">{initials(speaker.name)}</span>
                    {speaker.headshotUrl ? (
                      <img
                        src={speaker.headshotUrl}
                        alt={headshotAlt(speaker.name)}
                        width={52}
                        height={52}
                        loading="lazy"
                        decoding="async"
                        onError={(event) => { event.currentTarget.hidden = true; }}
                      />
                    ) : null}
                  </div>
                  <div className="speaker-card-copy">
                    <h2>{speaker.name}</h2>
                    {detail ? <p className="speaker-metadata">{detail}</p> : null}
                    {speaker.bio ? <p className="speaker-bio">{speaker.bio}</p> : null}
                    <div className="speaker-session-links" aria-label={`${speaker.name}'s sessions`}>
                      {speaker.sessions.map((session) => {
                        const placement = sessionPlacementLine(session, gallery.event.timezone);
                        return (
                          <Link className="speaker-session-link" href={`${scheduleUrl}#session-${session.id}`} key={session.id}>
                            <Mic2 size={14} aria-hidden="true" />
                            <span>
                              {session.title}
                              {/* Time and room, when the session is placed — the
                                  one thing a reader otherwise had to open the
                                  schedule to find. */}
                              {placement ? <span className="speaker-session-when">{placement}</span> : null}
                            </span>
                          </Link>
                        );
                      })}
                      {speaker.sessionsTruncated ? (
                        <Link className="speaker-session-link" href={scheduleUrl}>
                          <CalendarDays size={14} aria-hidden="true" />
                          <span>View all sessions</span>
                        </Link>
                      ) : null}
                    </div>

                    {/* Native <details>: the full profile opens in place without
                        hydration, so it is reachable with JavaScript disabled
                        and keyboard-operable by default. */}
                    <details className="speaker-detail">
                      <summary>
                        <span className="speaker-detail-open">Full profile</span>
                        <span className="speaker-detail-close">Hide profile</span>
                      </summary>
                      <div className="speaker-detail-body">
                        <h3 className="sr-only">About {speaker.name}</h3>
                        {speaker.bio
                          ? <p className="speaker-detail-bio">{speaker.bio}</p>
                          : <p className="speaker-detail-bio speaker-detail-missing">No bio has been published for {speaker.name} yet.</p>}
                        <dl className="speaker-detail-facts">
                          {speaker.jobTitle ? (
                            <div><dt>Role</dt><dd>{speaker.jobTitle}</dd></div>
                          ) : null}
                          {speaker.company ? (
                            <div><dt>Company</dt><dd>{speaker.company}</dd></div>
                          ) : null}
                          <div>
                            <dt>{speaker.sessions.length === 1 ? "Session" : "Sessions"}</dt>
                            <dd>
                              <ul className="speaker-detail-sessions">
                                {speaker.sessions.map((session) => {
                                  const placement = sessionPlacementLine(session, gallery.event.timezone);
                                  return (
                                    <li key={session.id}>
                                      <Link href={`${scheduleUrl}#session-${session.id}`}>{session.title}</Link>
                                      {session.track ? <span className="speaker-detail-track">{session.track.name}</span> : null}
                                      {placement ? <span className="speaker-detail-when">{placement}</span> : null}
                                    </li>
                                  );
                                })}
                              </ul>
                            </dd>
                          </div>
                        </dl>
                      </div>
                    </details>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </main>

      <footer className="speaker-embed-footer">Powered by Greenroom</footer>
    </div>
  );
}
