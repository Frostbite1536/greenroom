"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CalendarDays, LayoutGrid, List, Plus } from "lucide-react";
import { ROOMS, SLOTS, TRACKS, detectConflicts, type SlotModel } from "@/lib/fixtures";
import { EmptyState, Pill } from "@/components/ui";

type View = "list" | "day" | "rooms" | "conflicts";

const DAY_START = 9 * 60; // 09:00
const DAY_END = 15 * 60; // 15:00
const PX_PER_MIN = 1; // 60px per hour

/** Parse the local HH:MM out of an ISO string with an explicit offset. */
function localMinutes(iso: string): number {
  const t = iso.slice(11, 16);
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function timeLabel(iso: string): string {
  const mins = localMinutes(iso);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, "0")} ${ampm}`;
}
function trackColor(trackId: string) {
  return TRACKS.find((t) => t.id === trackId)?.color ?? "#687276";
}

export function AgendaBuilder() {
  const [view, setView] = useState<View>("day");
  const slots = SLOTS;
  const conflicts = useMemo(() => detectConflicts(slots), [slots]);
  const conflictIds = useMemo(() => new Set(conflicts.flatMap((c) => [c.slotId, c.conflictingSlotId])), [conflicts]);

  return (
    <div className="card">
      <div className="agenda-toolbar" role="tablist" aria-label="Agenda views">
        <ViewTab id="list" view={view} setView={setView} icon={<List size={15} />} label="List" />
        <ViewTab id="day" view={view} setView={setView} icon={<CalendarDays size={15} />} label="Day" />
        <ViewTab id="rooms" view={view} setView={setView} icon={<LayoutGrid size={15} />} label="Rooms" />
        <ViewTab id="conflicts" view={view} setView={setView} icon={<AlertTriangle size={15} />} label={`Conflicts${conflicts.length ? ` (${conflicts.length})` : ""}`} />
        <span className="spacer" />
        <button className="primary-button" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Plus size={15} /> Add session</button>
      </div>

      {conflicts.length > 0 && view !== "conflicts" && (
        <div style={{ padding: 12 }}>
          <div className="conflict-banner">
            <AlertTriangle size={17} aria-hidden="true" />
            <div>
              <strong>{conflicts.length} scheduling conflict{conflicts.length > 1 ? "s" : ""} detected.</strong>{" "}
              <button className="link-button" onClick={() => setView("conflicts")}>Review conflicts</button>
            </div>
          </div>
        </div>
      )}

      {view === "list" && <ListView slots={slots} conflictIds={conflictIds} />}
      {view === "day" && <DayGrid slots={slots} conflictIds={conflictIds} />}
      {view === "rooms" && <DayGrid slots={slots} conflictIds={conflictIds} byRoom />}
      {view === "conflicts" && <ConflictsView slots={slots} conflicts={conflicts} />}
    </div>
  );
}

function ViewTab({ id, view, setView, icon, label }: { id: View; view: View; setView: (v: View) => void; icon: React.ReactNode; label: string }) {
  return (
    <button role="tab" aria-selected={view === id} className={`ghost-button ${view === id ? "active" : ""}`} onClick={() => setView(id)}>
      {icon} {label}
    </button>
  );
}

function ListView({ slots, conflictIds }: { slots: SlotModel[]; conflictIds: Set<string> }) {
  const sorted = [...slots].sort((a, b) => localMinutes(a.startsAt) - localMinutes(b.startsAt));
  if (sorted.length === 0) {
    return <EmptyState icon={<CalendarDays size={22} />} title="Nothing here yet">Scheduled sessions will appear in list view.</EmptyState>;
  }
  return (
    <div>
      {sorted.map((s) => (
        <div className="agenda-list-item" key={s.id}>
          <span className="time">{timeLabel(s.startsAt)}–{timeLabel(s.endsAt)}</span>
          <span className="track-dot" style={{ background: trackColor(s.trackId) }} aria-hidden="true" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="cell-title">{s.title}</div>
            <div className="cell-sub">{s.speakers} · {ROOMS.find((r) => r.id === s.roomId)?.name}</div>
          </div>
          {conflictIds.has(s.id) ? <Pill tone="bad"><AlertTriangle size={12} /> Conflict</Pill> : null}
        </div>
      ))}
    </div>
  );
}

function DayGrid({ slots, conflictIds, byRoom = true }: { slots: SlotModel[]; conflictIds: Set<string>; byRoom?: boolean }) {
  const columns = byRoom ? ROOMS.map((r) => ({ id: r.id, name: r.name })) : TRACKS.map((t) => ({ id: t.id, name: t.name }));
  const hours = Array.from({ length: (DAY_END - DAY_START) / 60 + 1 }, (_, i) => DAY_START + i * 60);

  return (
    <div className="table-scroll">
      <div style={{ ["--room-count" as string]: columns.length }}>
        <div className="agenda-grid">
          <div className="col-head time-head">PDT</div>
          {columns.map((c) => <div className="col-head" key={c.id}>{c.name}</div>)}
        </div>
        <div className="agenda-body">
          <div className="time-col">
            {hours.map((h) => (
              <div className="time-label" key={h}>{timeLabel(`0000-00-00T${String(Math.floor(h / 60)).padStart(2, "0")}:${String(h % 60).padStart(2, "0")}:00`)}</div>
            ))}
          </div>
          {columns.map((col) => (
            <div className="room-col" key={col.id} style={{ position: "relative" }}>
              {hours.map((h) => <div className="hour-line" key={h} />)}
              {slots
                .filter((s) => (byRoom ? s.roomId === col.id : s.trackId === col.id))
                .map((s) => {
                  const top = (localMinutes(s.startsAt) - DAY_START) * PX_PER_MIN + 1;
                  const height = (localMinutes(s.endsAt) - localMinutes(s.startsAt)) * PX_PER_MIN - 3;
                  const conflict = conflictIds.has(s.id);
                  return (
                    <div
                      key={s.id}
                      className={`slot-block ${conflict ? "conflict" : ""}`}
                      style={{ top, height, background: trackColor(s.trackId) }}
                      title={`${s.title} · ${timeLabel(s.startsAt)}–${timeLabel(s.endsAt)}`}
                    >
                      {conflict ? <span className="conflict-flag"><AlertTriangle size={12} /></span> : null}
                      <strong>{s.title}</strong>
                      <span>{s.speakers}</span>
                    </div>
                  );
                })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ConflictsView({ slots, conflicts }: { slots: SlotModel[]; conflicts: ReturnType<typeof detectConflicts> }) {
  if (conflicts.length === 0) {
    return <EmptyState icon={<AlertTriangle size={22} />} title="No conflicts">Every room and speaker has a clear schedule.</EmptyState>;
  }
  const byId = (id: string) => slots.find((s) => s.id === id)!;
  return (
    <div style={{ padding: 14, display: "grid", gap: 12 }}>
      {conflicts.map((c, i) => {
        const a = byId(c.slotId);
        const b = byId(c.conflictingSlotId);
        return (
          <div className="conflict-banner" key={i} style={{ flexDirection: "column" }}>
            <div className="row" style={{ gap: 8 }}>
              <AlertTriangle size={16} />
              <strong>{c.type === "ROOM_OVERLAP" ? "Room double-booked" : "Speaker double-booked"}</strong>
              <Pill tone="bad">{c.message}</Pill>
            </div>
            <div className="hint" style={{ color: "#8a2f22" }}>
              “{a.title}” ({timeLabel(a.startsAt)}–{timeLabel(a.endsAt)}) overlaps “{b.title}” ({timeLabel(b.startsAt)}–{timeLabel(b.endsAt)})
            </div>
          </div>
        );
      })}
    </div>
  );
}
