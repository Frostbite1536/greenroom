"use client";

import { useMemo, useState } from "react";
import { CalendarDays, CalendarPlus, Download, MapPin, User } from "lucide-react";
import type { PublicAgenda, PublicAgendaSession } from "@/lib/data/reads";
import { calendarExportUrl } from "@/lib/ics-embed";
import { formatDayLabel, formatTime, zonedParts } from "@/lib/tz";
import { EmptyState } from "@/components/ui";

export function EmbedSchedule({ agenda }: { agenda: PublicAgenda }) {
  const [track, setTrack] = useState("all");
  const tz = agenda.event.timezone;

  const filtered = useMemo(
    () => agenda.sessions.filter((s) => track === "all" || s.track?.id === track),
    [agenda.sessions, track],
  );

  // Group by event-local day, then by start time.
  const days = useMemo(() => {
    const map = new Map<string, PublicAgendaSession[]>();
    for (const s of filtered) {
      const key = zonedParts(s.startsAt, tz).dateKey;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered, tz]);

  return (
    <div className="embed-page">
      <header className="embed-header">
        <div className="row wrap" style={{ justifyContent: "space-between", gap: 12 }}>
          <div>
            <h1>{agenda.event.name}</h1>
            <p className="hint">
              {agenda.sessions.length} sessions
              {agenda.event.startsAt
                ? ` · ${new Intl.DateTimeFormat(undefined, { timeZone: tz, month: "long", day: "numeric", year: "numeric" }).format(new Date(agenda.event.startsAt))}`
                : ""}
            </p>
          </div>
          {filtered.length > 0 && (
            <a
              className="ghost-button"
              href={calendarExportUrl(agenda.event.id)}
              style={{ textDecoration: "none" }}
            >
              <CalendarPlus size={15} /> Add all to calendar
            </a>
          )}
        </div>
        {agenda.tracks.length > 0 && (
          <div className="embed-filters" role="group" aria-label="Filter by track">
            <button className={`ghost-button ${track === "all" ? "active" : ""}`} onClick={() => setTrack("all")} aria-pressed={track === "all"}>
              All tracks
            </button>
            {agenda.tracks.map((t) => (
              <button
                key={t.id}
                className={`ghost-button ${track === t.id ? "active" : ""}`}
                onClick={() => setTrack(t.id)}
                aria-pressed={track === t.id}
              >
                <span style={{ width: 8, height: 8, borderRadius: 3, background: t.color, display: "inline-block" }} aria-hidden="true" /> {t.name}
              </button>
            ))}
          </div>
        )}
      </header>

      <div className="embed-body">
        {agenda.sessions.length === 0 ? (
          <EmptyState icon={<CalendarDays size={22} />} title="Schedule coming soon">
            Sessions will appear here once the agenda is published.
          </EmptyState>
        ) : filtered.length === 0 ? (
          <EmptyState icon={<CalendarDays size={22} />} title="No sessions in this track">
            Pick a different track to see more.
          </EmptyState>
        ) : (
          days.map(([dayKey, items]) => (
            <section key={dayKey}>
              <h2 className="time-heading" style={{ fontSize: 13 }}>{formatDayLabel(dayKey, tz)}</h2>
              {items.map((s) => (
                <article className="embed-session" key={s.slotId} style={{ marginTop: 8 }}>
                  <span className="rail" style={{ background: s.track?.color ?? "#687276" }} aria-hidden="true" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h3>{s.title}</h3>
                    <div className="meta">
                      {s.speakers.length > 0 && (
                        <span className="row" style={{ gap: 4 }}><User size={13} aria-hidden="true" /> {s.speakers.join(", ")}</span>
                      )}
                      <span className="row" style={{ gap: 4 }}><MapPin size={13} aria-hidden="true" /> {s.room.name}</span>
                      <span>{formatTime(s.startsAt, tz)}–{formatTime(s.endsAt, tz)}</span>
                      {s.track ? <span>{s.track.name}</span> : null}
                    </div>
                    <a
                      className="ghost-button ics-button"
                      href={calendarExportUrl(agenda.event.id, s.sessionId)}
                      style={{ textDecoration: "none" }}
                    >
                      <Download size={14} /> Add to calendar
                    </a>
                  </div>
                </article>
              ))}
            </section>
          ))
        )}
      </div>
    </div>
  );
}
