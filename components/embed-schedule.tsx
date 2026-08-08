"use client";

import { useMemo, useState } from "react";
import { CalendarPlus, Download, MapPin, User } from "lucide-react";
import { EVENT_META, ROOMS, SLOTS, TRACKS, type SlotModel } from "@/lib/fixtures";
import { downloadIcs } from "@/lib/ics-embed";

function localMinutes(iso: string) {
  const [h, m] = iso.slice(11, 16).split(":").map(Number);
  return h * 60 + m;
}
function timeLabel(iso: string) {
  const [h, m] = iso.slice(11, 16).split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, "0")} ${ampm}`;
}
const trackColor = (id: string) => TRACKS.find((t) => t.id === id)?.color ?? "#687276";
const roomName = (id: string) => ROOMS.find((r) => r.id === id)?.name ?? id;

export function EmbedSchedule() {
  const [track, setTrack] = useState<string>("all");

  const filtered = useMemo(
    () => SLOTS.filter((s) => track === "all" || s.trackId === track).sort((a, b) => localMinutes(a.startsAt) - localMinutes(b.startsAt)),
    [track],
  );

  // group into time headings
  const groups = useMemo(() => {
    const map = new Map<string, SlotModel[]>();
    for (const s of filtered) {
      const key = timeLabel(s.startsAt);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return [...map.entries()];
  }, [filtered]);

  return (
    <div className="embed-page">
      <header className="embed-header">
        <div className="row" style={{ justifyContent: "space-between", gap: 12 }}>
          <div>
            <h1>{EVENT_META.name}</h1>
            <p className="hint">{EVENT_META.dateLabel} · {EVENT_META.location}</p>
          </div>
          <button className="ghost-button" onClick={() => downloadIcs(filtered, EVENT_META.name, `${EVENT_META.slug}.ics`)}>
            <CalendarPlus size={15} /> Add all to calendar
          </button>
        </div>
        <div className="embed-filters">
          <button className={`ghost-button ${track === "all" ? "active" : ""}`} onClick={() => setTrack("all")}>All tracks</button>
          {TRACKS.map((t) => (
            <button key={t.id} className={`ghost-button ${track === t.id ? "active" : ""}`} onClick={() => setTrack(t.id)}>
              <span className="track-dot" style={{ width: 8, height: 8, borderRadius: 3, background: t.color }} aria-hidden="true" /> {t.name}
            </button>
          ))}
        </div>
      </header>

      <div className="embed-body">
        {groups.map(([time, items]) => (
          <div key={time}>
            <div className="time-heading">{time}</div>
            {items.map((s) => (
              <div className="embed-session" key={s.id} style={{ marginTop: 8 }}>
                <span className="rail" style={{ background: trackColor(s.trackId) }} aria-hidden="true" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3>{s.title}</h3>
                  <div className="meta">
                    <span className="row" style={{ gap: 4 }}><User size={13} /> {s.speakers}</span>
                    <span className="row" style={{ gap: 4 }}><MapPin size={13} /> {roomName(s.roomId)}</span>
                    <span>{timeLabel(s.startsAt)}–{timeLabel(s.endsAt)}</span>
                  </div>
                  <button className="ghost-button ics-button" onClick={() => downloadIcs([s], EVENT_META.name, `${s.sessionId}.ics`)}>
                    <Download size={14} /> Add to calendar
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
