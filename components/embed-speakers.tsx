"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CalendarDays, Mic2, Search, Users } from "lucide-react";
import type { PublicSpeaker, PublicSpeakers } from "@/lib/public-speakers";
import { EmptyState } from "@/components/ui";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

function profileLine(speaker: PublicSpeaker): string | null {
  if (speaker.jobTitle && speaker.company) return `${speaker.jobTitle} at ${speaker.company}`;
  return speaker.jobTitle ?? speaker.company;
}

function eventDateRange(gallery: PublicSpeakers): string | null {
  const { startsAt, endsAt, timezone } = gallery.event;
  if (!startsAt) return null;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return endsAt ? formatter.formatRange(new Date(startsAt), new Date(endsAt)) : formatter.format(new Date(startsAt));
}

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
      return [speaker.name, speaker.company, speaker.jobTitle]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    }),
    [gallery.speakers, normalizedQuery, track],
  );

  const scheduleUrl = `/embed/schedule?event=${encodeURIComponent(gallery.event.slug)}`;
  const dates = eventDateRange(gallery);

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
                {gallery.speakers.length} {gallery.speakers.length === 1 ? "speaker" : "speakers"}
                {dates ? ` · ${dates}` : ""}
              </p>
            </div>
            <Link className="ghost-button" href={scheduleUrl}>
              <CalendarDays size={15} aria-hidden="true" /> Schedule
            </Link>
          </div>

          <div className="speaker-gallery-controls">
            <label className="speaker-search">
              <span className="sr-only">Search speakers by name or company</span>
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
                placeholder="Search speakers by name or company…"
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
          </div>
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
              const detail = profileLine(speaker);
              const key = `${speaker.name}-${speaker.sessions.map((session) => session.id).join("-")}-${index}`;
              return (
                <article className="speaker-card" key={key}>
                  <div className="speaker-avatar" aria-hidden="true">
                    <span>{initials(speaker.name)}</span>
                    {speaker.headshotUrl ? (
                      <img
                        src={speaker.headshotUrl}
                        alt=""
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
                      {speaker.sessions.map((session) => (
                        <Link className="speaker-session-link" href={`${scheduleUrl}#session-${session.id}`} key={session.id}>
                          <Mic2 size={14} aria-hidden="true" />
                          <span>{session.title}</span>
                        </Link>
                      ))}
                      {speaker.sessionsTruncated ? (
                        <Link className="speaker-session-link" href={scheduleUrl}>
                          <CalendarDays size={14} aria-hidden="true" />
                          <span>View all sessions</span>
                        </Link>
                      ) : null}
                    </div>
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
