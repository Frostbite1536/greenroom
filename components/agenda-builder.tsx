"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CalendarDays, CalendarRange, CalendarX, LayoutGrid, List, X } from "lucide-react";
import type { AgendaData, AgendaSession } from "@/lib/data/reads";
import { conflictedSessionIds, findConflicts, placedSessions } from "@/lib/agenda-conflicts";
import { gridBounds, hourMarks, packLanes } from "@/lib/agenda-layout";
import { readableChip } from "@/lib/color-contrast";
import { publicationControl, unpublishedNotice } from "@/lib/agenda-publication";
import { apiDelete, apiPatch, apiPost } from "@/lib/api-client";
import { EmptyState, Pill } from "@/components/ui";
import {
  formatDayLabel,
  formatTime,
  minutesToTimeInput,
  tzAbbreviation,
  zonedParts,
  zonedToUtcIso,
} from "@/lib/tz";

type View = "list" | "day" | "week" | "rooms" | "conflicts";

const PX_PER_MIN = 1;
/** Drop targets snap to 5-minute marks so dragging produces tidy start times. */
const SNAP_MINUTES = 5;

/** Local echo of a slot move while the server round-trip is in flight. */
type SlotOverride = { roomId: string; startsAt: string; endsAt: string };

/**
 * Map placed sessions onto the event-local minute intervals the grids lay out.
 * `endMin` is derived from the real duration rather than the end timestamp's
 * minute-of-day so a session crossing local midnight cannot invert its
 * interval; it renders clamped to the end of its day column instead.
 */
function toIntervals(sessions: Placed[], tz: string) {
  return sessions.map((session) => {
    const startMin = zonedParts(session.slot.startsAt, tz).minutesOfDay;
    const durationMin = Math.max(
      0,
      Math.round((new Date(session.slot.endsAt).getTime() - new Date(session.slot.startsAt).getTime()) / 60000),
    );
    return { session, startMin, endMin: Math.min(startMin + durationMin, 24 * 60) };
  });
}

export function AgendaBuilder({ data }: { data: AgendaData }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [view, setView] = useState<View>("day");
  const [scheduling, setScheduling] = useState<AgendaSession | null>(null);
  const [overrides, setOverrides] = useState<Record<string, SlotOverride>>({});
  const [movingId, setMovingId] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);

  const tz = data.timezone;
  const roomName = (id: string) => data.rooms.find((r) => r.id === id)?.name ?? id;
  const trackColor = (id: string | null) => data.tracks.find((t) => t.id === id)?.color ?? "#687276";

  // Fresh server data supersedes any local echo.
  useEffect(() => setOverrides({}), [data.sessions]);

  const sessions = useMemo(
    () =>
      data.sessions.map((s) => {
        const override = overrides[s.id];
        return override && s.slot ? { ...s, slot: { ...s.slot, ...override } } : s;
      }),
    [data.sessions, overrides],
  );

  const placed = useMemo(() => placedSessions(sessions), [sessions]);
  const unscheduled = useMemo(() => sessions.filter((s) => s.slot === null), [sessions]);
  const conflicts = useMemo(() => findConflicts(sessions, roomName), [sessions]);
  const conflictIds = useMemo(() => conflictedSessionIds(conflicts), [conflicts]);

  // Days that actually have content, so the grid follows the real event.
  const days = useMemo(() => {
    const set = new Set(placed.map((s) => zonedParts(s.slot.startsAt, tz).dateKey));
    return [...set].sort();
  }, [placed, tz]);
  const [day, setDay] = useState<string | null>(null);
  const activeDay = day && days.includes(day) ? day : (days[0] ?? null);

  /**
   * Publish or unpublish one talk. The server is the only authority: this
   * refreshes the RSC payload rather than patching a local list, so what the
   * grid shows afterwards is what the public surfaces will actually read.
   */
  async function setPublication(session: AgendaSession) {
    const control = publicationControl(session.contentStatus);
    if (control.confirm && !window.confirm(control.confirm(session.title))) return;
    setPublishError(null);
    const res = await apiPatch("/api/agenda/sessions", {
      sessionId: session.id,
      contentStatus: control.next,
    });
    if (!res.ok) {
      setPublishError(res.error.message);
      return;
    }
    startTransition(() => router.refresh());
  }

  async function unschedule(sessionId: string, title?: string) {
    if (!window.confirm(`Unschedule${title ? ` “${title}”` : " this session"}?`)) return false;
    const res = await apiDelete(`/api/agenda/slots?sessionId=${encodeURIComponent(sessionId)}`);
    if (res.ok) startTransition(() => router.refresh());
    return res.ok;
  }

  /**
   * Drag-and-drop move. The block follows the cursor optimistically, but the
   * server re-checks room/speaker overlap transactionally and is the only
   * authority: a refusal drops the local echo (the block snaps back) and shows
   * the conflict message the API returned.
   */
  async function moveSlot(session: Placed, roomId: string, startMin: number) {
    const dayKey = zonedParts(session.slot.startsAt, tz).dateKey;
    const startsAt = zonedToUtcIso(dayKey, minutesToTimeInput(startMin), tz);
    if (startsAt === session.slot.startsAt && roomId === session.slot.roomId) return;

    const durationMs = new Date(session.slot.endsAt).getTime() - new Date(session.slot.startsAt).getTime();
    const endsAt = new Date(new Date(startsAt).getTime() + durationMs).toISOString();

    setMoveError(null);
    setMovingId(session.id);
    setOverrides((prev) => ({ ...prev, [session.id]: { roomId, startsAt, endsAt } }));

    const res = await apiPost("/api/agenda/slots", {
      eventId: data.eventId,
      sessionId: session.id,
      roomId,
      trackId: session.slot.trackId || undefined,
      startsAt,
      endsAt,
    });
    setMovingId(null);

    if (!res.ok) {
      setOverrides((prev) => {
        const next = { ...prev };
        delete next[session.id];
        return next;
      });
      const detail = res.error.fieldErrors?.conflicts?.join(" · ");
      setMoveError(detail ? `${res.error.message} ${detail}` : res.error.message);
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div className="card">
      <div className="agenda-toolbar" role="group" aria-label="Agenda views">
        <ViewTab id="list" view={view} setView={setView} icon={<List size={15} />} label="List" />
        <ViewTab id="day" view={view} setView={setView} icon={<CalendarDays size={15} />} label="Day" />
        <ViewTab id="week" view={view} setView={setView} icon={<CalendarRange size={15} />} label="Week" />
        <ViewTab id="rooms" view={view} setView={setView} icon={<LayoutGrid size={15} />} label="Tracks" />
        <ViewTab
          id="conflicts"
          view={view}
          setView={setView}
          icon={<AlertTriangle size={15} />}
          label={`Conflicts${conflicts.length ? ` (${conflicts.length})` : ""}`}
        />
        <span className="spacer" />
        {days.length > 1 && (view === "day" || view === "rooms") && (
          <div className="seg" role="group" aria-label="Event day">
            {days.map((d) => (
              <button key={d} className={activeDay === d ? "active" : ""} onClick={() => setDay(d)}>
                {formatDayLabel(d, tz)}
              </button>
            ))}
          </div>
        )}
      </div>

      {moveError && (
        <div style={{ padding: "12px 12px 0" }}>
          <div className="conflict-banner" role="alert">
            <AlertTriangle size={17} aria-hidden="true" />
            <div>
              <strong>Move refused.</strong> {moveError}{" "}
              <button className="link-button" onClick={() => setMoveError(null)}>Dismiss</button>
            </div>
          </div>
        </div>
      )}

      {publishError && (
        <div style={{ padding: "12px 12px 0" }}>
          <div className="conflict-banner" role="alert">
            <AlertTriangle size={17} aria-hidden="true" />
            <div>
              <strong>Publication change refused.</strong> {publishError}{" "}
              <button className="link-button" onClick={() => setPublishError(null)}>Dismiss</button>
            </div>
          </div>
        </div>
      )}

      {/* Says nothing at all when the whole programme is published, rather than
          reporting a reassuring zero. */}
      {unpublishedNotice(sessions.map((s) => s.contentStatus)) ? (
        <div style={{ padding: "12px 12px 0" }}>
          <p className="hint" role="status">{unpublishedNotice(sessions.map((s) => s.contentStatus))}</p>
        </div>
      ) : null}

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

      {unscheduled.length > 0 && (
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
          <p className="field-label" style={{ marginBottom: 8 }}>
            Unscheduled backlog <span className="hint">({unscheduled.length})</span>
          </p>
          <div className="row wrap" style={{ gap: 8 }}>
            {unscheduled.map((s) => (
              <button key={s.id} className="ghost-button" onClick={() => setScheduling(s)}>
                {s.title}{" "}
                <span className="hint">
                  · {s.durationMinutes}m{s.category ? ` · ${s.category.name}` : ""}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {view === "list" && (
        <ListView
          sessions={placed}
          tz={tz}
          conflictIds={conflictIds}
          roomName={roomName}
          trackColor={trackColor}
          onReschedule={setScheduling}
          onUnschedule={unschedule}
          onPublication={setPublication}
          busy={pending}
        />
      )}
      {(view === "day" || view === "rooms") && (
        <DayGrid
          sessions={placed}
          tz={tz}
          day={activeDay}
          columns={
            view === "day"
              ? data.rooms.map((r) => ({ id: r.id, name: r.name }))
              : data.tracks.map((t) => ({ id: t.id, name: t.name }))
          }
          groupBy={view === "day" ? "room" : "track"}
          conflictIds={conflictIds}
          trackColor={trackColor}
          onSelect={setScheduling}
          onMove={view === "day" ? moveSlot : undefined}
          movingId={movingId}
        />
      )}
      {view === "week" && (
        <WeekGrid
          sessions={placed}
          tz={tz}
          days={days}
          conflictIds={conflictIds}
          trackColor={trackColor}
          roomName={roomName}
          onSelect={setScheduling}
        />
      )}
      {view === "conflicts" && (
        <ConflictsView conflicts={conflicts} sessions={sessions} tz={tz} onSelect={setScheduling} />
      )}

      {scheduling ? (
        <ScheduleDialog
          session={scheduling}
          data={data}
          defaultDay={activeDay}
          onClose={() => setScheduling(null)}
          onSaved={() => {
            setScheduling(null);
            startTransition(() => router.refresh());
          }}
          onUnschedule={async () => {
            if (await unschedule(scheduling.id, scheduling.title)) setScheduling(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ViewTab({ id, view, setView, icon, label }: { id: View; view: View; setView: (v: View) => void; icon: React.ReactNode; label: string }) {
  return (
    <button aria-pressed={view === id} className={`ghost-button ${view === id ? "active" : ""}`} onClick={() => setView(id)}>
      {icon} {label}
    </button>
  );
}

type Placed = ReturnType<typeof placedSessions>[number];

function ListView({
  sessions,
  tz,
  conflictIds,
  roomName,
  trackColor,
  onReschedule,
  onUnschedule,
  onPublication,
  busy,
}: {
  sessions: Placed[];
  tz: string;
  conflictIds: Set<string>;
  roomName: (id: string) => string;
  trackColor: (id: string | null) => string;
  onReschedule: (s: AgendaSession) => void;
  onUnschedule: (id: string, title?: string) => void;
  onPublication: (s: AgendaSession) => void;
  busy: boolean;
}) {
  const sorted = [...sessions].sort((a, b) => a.slot.startsAt.localeCompare(b.slot.startsAt));
  if (sorted.length === 0) {
    return (
      <EmptyState icon={<CalendarDays size={22} />} title="Nothing scheduled yet">
        Accept an abstract and create a session, then place it on the schedule.
      </EmptyState>
    );
  }
  return (
    <div>
      {sorted.map((s) => (
        <div className="agenda-list-item" key={s.id}>
          <span className="time">
            {formatTime(s.slot.startsAt, tz)}–{formatTime(s.slot.endsAt, tz)}
          </span>
          <span className="track-dot" style={{ background: trackColor(s.slot.trackId) }} aria-hidden="true" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="cell-title">{s.title}</div>
            <div className="cell-sub">
              {s.speakers.map((sp) => sp.name).join(", ") || "No speakers"} · {roomName(s.slot.roomId)}
              {/* The topic the proposal was submitted under. Named separately
                  from the track dot beside it: one is the swimlane an organizer
                  placed the talk in, the other is what the speaker chose. */}
              {s.category ? ` · ${s.category.name}` : ""}
            </div>
          </div>
          {conflictIds.has(s.id) ? <Pill tone="bad"><AlertTriangle size={12} /> Conflict</Pill> : null}
          {/* Stated in words, not by absence: an unpublished talk still sits in
              this grid, so nothing else here would tell an organizer that the
              public agenda has stopped showing it. */}
          {s.contentStatus === "DRAFT" ? <Pill tone="neutral">Unpublished</Pill> : null}
          <button
            className="ghost-button"
            disabled={busy}
            onClick={() => onPublication(s)}
            aria-label={publicationControl(s.contentStatus).actionLabel(s.title)}
          >
            {publicationControl(s.contentStatus).label}
          </button>
          <button className="ghost-button" onClick={() => onReschedule(s)}>Move</button>
          <button className="ghost-button danger-button" disabled={busy} onClick={() => onUnschedule(s.id, s.title)} aria-label={`Unschedule ${s.title}`}>
            <CalendarX size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}

function DayGrid({
  sessions,
  tz,
  day,
  columns,
  groupBy,
  conflictIds,
  trackColor,
  onSelect,
  onMove,
  movingId,
}: {
  sessions: Placed[];
  tz: string;
  day: string | null;
  columns: { id: string; name: string }[];
  groupBy: "room" | "track";
  conflictIds: Set<string>;
  trackColor: (id: string | null) => string;
  onSelect: (s: AgendaSession) => void;
  /** Omitted for the track view, where a column is not a bookable resource. */
  onMove?: (session: Placed, roomId: string, startMin: number) => void;
  movingId: string | null;
}) {
  // A drag carries an object, which `dataTransfer` cannot hold across the
  // dragover/drop handlers, so the payload lives in a ref.
  const drag = useRef<{ session: Placed; grabOffsetY: number; durationMin: number } | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);
  const draggable = typeof onMove === "function";

  if (!day) {
    return (
      <EmptyState icon={<CalendarDays size={22} />} title="Nothing scheduled yet">
        Place a session from the backlog to start building the grid.
      </EmptyState>
    );
  }
  if (columns.length === 0) {
    return (
      <EmptyState icon={<LayoutGrid size={22} />} title={`No ${groupBy}s configured`}>
        Add {groupBy}s to the event to use this view.
      </EmptyState>
    );
  }

  const daySessions = sessions.filter((s) => zonedParts(s.slot.startsAt, tz).dateKey === day);
  const bounds = gridBounds(toIntervals(daySessions, tz));
  const hours = hourMarks(bounds);

  function handleDrop(event: React.DragEvent<HTMLDivElement>, colId: string) {
    event.preventDefault();
    setDropCol(null);
    const payload = drag.current;
    drag.current = null;
    if (!payload || !onMove) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const rawStart = bounds.start + (event.clientY - rect.top - payload.grabOffsetY) / PX_PER_MIN;
    const snapped = Math.round(rawStart / SNAP_MINUTES) * SNAP_MINUTES;
    const clamped = Math.max(bounds.start, Math.min(snapped, bounds.end - payload.durationMin));
    onMove(payload.session, colId, clamped);
  }

  return (
    <div className="table-scroll">
      {draggable ? (
        <p className="hint agenda-drag-hint">
          Drag a session to another room or time. Conflicts are re-checked on the server, so a
          refused move snaps back. Keyboard: focus a session and press Enter to open the scheduler.
        </p>
      ) : null}
      <div style={{ ["--room-count" as string]: columns.length }}>
        <div className="agenda-grid">
          <div className="col-head time-head">{tzAbbreviation(tz)}</div>
          {columns.map((c) => <div className="col-head" key={c.id}>{c.name}</div>)}
        </div>
        <div className="agenda-body">
          <div className="time-col">
            {hours.map((h) => <div className="time-label" key={h}>{minutesToTimeInput(h)}</div>)}
          </div>
          {columns.map((col) => (
            <div
              className={`room-col ${dropCol === col.id ? "drop-target" : ""}`}
              key={col.id}
              onDragOver={draggable ? (event) => {
                if (!drag.current) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                if (dropCol !== col.id) setDropCol(col.id);
              } : undefined}
              onDragLeave={draggable ? (event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropCol(null);
              } : undefined}
              onDrop={draggable ? (event) => handleDrop(event, col.id) : undefined}
            >
              {hours.map((h) => <div className="hour-line" key={h} />)}
              {daySessions
                .filter((s) => (groupBy === "room" ? s.slot.roomId === col.id : s.slot.trackId === col.id))
                .map((s) => {
                  const start = zonedParts(s.slot.startsAt, tz).minutesOfDay;
                  // Duration from the real timestamps, clamped to the day
                  // column: independent minute-of-day endpoints invert across
                  // local midnight (same rule as toIntervals above).
                  const durationMin = Math.min(
                    Math.max(0, Math.round((new Date(s.slot.endsAt).getTime() - new Date(s.slot.startsAt).getTime()) / 60000)),
                    24 * 60 - start,
                  );
                  const top = (start - bounds.start) * PX_PER_MIN + 1;
                  const height = Math.max(18, durationMin * PX_PER_MIN - 3);
                  const conflict = conflictIds.has(s.id);
                  const moving = movingId === s.id;
                  // Track colours are operator-chosen, so the chip derives its
                  // own legible text colour instead of assuming white works.
                  const chip = readableChip(trackColor(s.slot.trackId));
                  return (
                    <button
                      key={s.id}
                      className={`slot-block ${conflict ? "conflict" : ""} ${draggable ? "draggable" : ""} ${moving ? "moving" : ""}`}
                      style={{ top, height, background: chip.background, color: chip.color, border: "none", textAlign: "left" }}
                      title={`${s.title} · ${formatTime(s.slot.startsAt, tz)}–${formatTime(s.slot.endsAt, tz)}${draggable ? " — drag to move" : ""}`}
                      draggable={draggable && movingId === null}
                      onDragStart={draggable ? (event) => {
                        // One move at a time: racing requests could commit the
                        // older drop last and desync the persisted position.
                        if (movingId !== null) {
                          event.preventDefault();
                          return;
                        }
                        drag.current = {
                          session: s,
                          grabOffsetY: event.clientY - event.currentTarget.getBoundingClientRect().top,
                          durationMin,
                        };
                        event.dataTransfer.effectAllowed = "move";
                        // Firefox refuses to start a drag without payload data.
                        event.dataTransfer.setData("text/plain", s.id);
                      } : undefined}
                      onDragEnd={draggable ? () => {
                        drag.current = null;
                        setDropCol(null);
                      } : undefined}
                      onClick={() => onSelect(s)}
                    >
                      {conflict ? <span className="conflict-flag"><AlertTriangle size={12} /></span> : null}
                      <strong>{s.title}</strong>
                      <span>{s.speakers.map((sp) => sp.name).join(", ")}</span>
                    </button>
                  );
                })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Read-only multi-day overview: one column per event day, every room folded
 * into that column with lane packing. Scheduling still happens through the
 * dialog, so the server stays the only conflict authority.
 */
function WeekGrid({
  sessions,
  tz,
  days,
  conflictIds,
  trackColor,
  roomName,
  onSelect,
}: {
  sessions: Placed[];
  tz: string;
  days: string[];
  conflictIds: Set<string>;
  trackColor: (id: string | null) => string;
  roomName: (id: string) => string;
  onSelect: (s: AgendaSession) => void;
}) {
  if (days.length === 0) {
    return (
      <EmptyState icon={<CalendarRange size={22} />} title="Nothing scheduled yet">
        Place a session from the backlog to see the week take shape.
      </EmptyState>
    );
  }

  const bounds = gridBounds(toIntervals(sessions, tz));
  const hours = hourMarks(bounds);

  return (
    <div className="table-scroll">
      <div style={{ ["--room-count" as string]: days.length }}>
        <div className="agenda-grid">
          <div className="col-head time-head">{tzAbbreviation(tz)}</div>
          {days.map((d) => <div className="col-head" key={d}>{formatDayLabel(d, tz)}</div>)}
        </div>
        <div className="agenda-body">
          <div className="time-col">
            {hours.map((h) => <div className="time-label" key={h}>{minutesToTimeInput(h)}</div>)}
          </div>
          {days.map((d) => {
            const dayItems = toIntervals(
              sessions.filter((s) => zonedParts(s.slot.startsAt, tz).dateKey === d),
              tz,
            ).sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
            const { lanes, laneCount } = packLanes(dayItems);

            return (
              <div className="room-col" key={d}>
                {hours.map((h) => <div className="hour-line" key={h} />)}
                {dayItems.map((item, i) => {
                  const s = item.session;
                  const conflict = conflictIds.has(s.id);
                  const width = 100 / laneCount;
                  const chip = readableChip(trackColor(s.slot.trackId));
                  return (
                    <button
                      key={s.id}
                      className={`slot-block week-block ${conflict ? "conflict" : ""}`}
                      style={{
                        top: (item.startMin - bounds.start) * PX_PER_MIN + 1,
                        height: Math.max(18, (item.endMin - item.startMin) * PX_PER_MIN - 3),
                        left: `calc(${lanes[i] * width}% + 2px)`,
                        width: `calc(${width}% - 4px)`,
                        right: "auto",
                        background: chip.background,
                        color: chip.color,
                      }}
                      title={`${s.title} · ${roomName(s.slot.roomId)} · ${formatTime(s.slot.startsAt, tz)}–${formatTime(s.slot.endsAt, tz)}`}
                      onClick={() => onSelect(s)}
                    >
                      {conflict ? <span className="conflict-flag"><AlertTriangle size={12} /></span> : null}
                      <strong>{s.title}</strong>
                      <span>{roomName(s.slot.roomId)}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ConflictsView({
  conflicts,
  sessions,
  tz,
  onSelect,
}: {
  conflicts: ReturnType<typeof findConflicts>;
  sessions: AgendaSession[];
  tz: string;
  onSelect: (s: AgendaSession) => void;
}) {
  if (conflicts.length === 0) {
    return (
      <EmptyState icon={<AlertTriangle size={22} />} title="No conflicts">
        Every room and speaker has a clear schedule.
      </EmptyState>
    );
  }
  const byId = (id: string) => sessions.find((s) => s.id === id);
  return (
    <div style={{ padding: 14, display: "grid", gap: 12 }}>
      {conflicts.map((c, i) => {
        const a = byId(c.sessionId);
        const b = byId(c.otherSessionId);
        if (!a?.slot || !b?.slot) return null;
        return (
          <div className="conflict-banner" key={i} style={{ flexDirection: "column", alignItems: "flex-start" }}>
            <div className="row wrap" style={{ gap: 8 }}>
              <AlertTriangle size={16} />
              <strong>{c.type === "ROOM_OVERLAP" ? "Room double-booked" : "Speaker double-booked"}</strong>
              <Pill tone="bad">{c.message}</Pill>
            </div>
            <div className="hint" style={{ color: "#8a2f22" }}>
              “{a.title}” ({formatTime(a.slot.startsAt, tz)}–{formatTime(a.slot.endsAt, tz)}) overlaps “{b.title}” (
              {formatTime(b.slot.startsAt, tz)}–{formatTime(b.slot.endsAt, tz)})
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="ghost-button" onClick={() => onSelect(a)}>Move “{a.title}”</button>
              <button className="ghost-button" onClick={() => onSelect(b)}>Move “{b.title}”</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Place or move a session. The server re-checks conflicts and can refuse. */
function ScheduleDialog({
  session,
  data,
  defaultDay,
  onClose,
  onSaved,
  onUnschedule,
}: {
  session: AgendaSession;
  data: AgendaData;
  defaultDay: string | null;
  onClose: () => void;
  onSaved: () => void;
  onUnschedule: () => void;
}) {
  const tz = data.timezone;
  const existing = session.slot;
  const initialDay = existing ? zonedParts(existing.startsAt, tz).dateKey : (defaultDay ?? new Date().toISOString().slice(0, 10));
  const initialTime = existing ? minutesToTimeInput(zonedParts(existing.startsAt, tz).minutesOfDay) : "09:00";

  const [day, setDay] = useState(initialDay);
  const [time, setTime] = useState(initialTime);
  const [roomId, setRoomId] = useState(existing?.roomId ?? data.rooms[0]?.id ?? "");
  const [trackId, setTrackId] = useState(existing?.trackId ?? "");
  const [duration, setDuration] = useState(session.durationMinutes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflictDetail, setConflictDetail] = useState<string[]>([]);

  async function save(force: boolean) {
    setBusy(true);
    setError(null);
    setConflictDetail([]);
    const startsAt = zonedToUtcIso(day, time, tz);
    const endsAt = new Date(new Date(startsAt).getTime() + duration * 60000).toISOString();

    const res = await apiPost(`/api/agenda/slots${force ? "?force=true" : ""}`, {
      eventId: data.eventId,
      sessionId: session.id,
      roomId,
      trackId: trackId || undefined,
      startsAt,
      endsAt,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message);
      setConflictDetail(res.error.fieldErrors?.conflicts ?? []);
      return;
    }
    onSaved();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Schedule ${session.title}`}
      style={{ position: "fixed", inset: 0, background: "rgba(20,28,30,0.35)", display: "grid", placeItems: "center", zIndex: 50, padding: 16 }}
      onClick={onClose}
    >
      <div className="card" style={{ width: "min(520px, 100%)", padding: 24 }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <p className="eyebrow">{existing ? "Move session" : "Schedule session"}</p>
          <button className="ghost-button" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <h2 style={{ margin: "0 0 4px" }}>{session.title}</h2>
        <p className="hint">{session.speakers.map((s) => s.name).join(", ") || "No speakers"}</p>

        <div className="grid-2" style={{ marginTop: 16 }}>
          <label className="stack">
            <span className="field-label">Date</span>
            <input type="date" className="text-input" value={day} onChange={(e) => setDay(e.target.value)} />
          </label>
          <label className="stack">
            <span className="field-label">Start time ({tzAbbreviation(tz)})</span>
            <input type="time" className="text-input" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
        </div>
        <div className="grid-2" style={{ marginTop: 12 }}>
          <label className="stack">
            <span className="field-label">Room</span>
            <select className="select-input" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              {data.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <label className="stack">
            <span className="field-label">Track</span>
            <select className="select-input" value={trackId} onChange={(e) => setTrackId(e.target.value)}>
              <option value="">No track</option>
              {data.tracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        </div>
        <label className="stack" style={{ marginTop: 12 }}>
          <span className="field-label">Duration (minutes)</span>
          <input type="number" min={5} max={480} className="text-input" value={duration} onChange={(e) => setDuration(Number(e.target.value))} />
        </label>

        {error ? (
          <div className="conflict-banner" style={{ marginTop: 14, flexDirection: "column", alignItems: "flex-start" }} role="alert">
            <strong>{error}</strong>
            {conflictDetail.length > 0 ? (
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {conflictDetail.map((c) => <li key={c}>{c}</li>)}
              </ul>
            ) : null}
          </div>
        ) : null}

        <div className="row wrap" style={{ marginTop: 18, gap: 8 }}>
          <button className="primary-button" disabled={busy || !roomId} onClick={() => save(false)}>
            {busy ? "Saving…" : existing ? "Move session" : "Schedule"}
          </button>
          {conflictDetail.length > 0 && (
            <button className="ghost-button danger-button" disabled={busy} onClick={() => save(true)}>
              Schedule anyway
            </button>
          )}
          {existing ? (
            <button className="ghost-button" disabled={busy} onClick={onUnschedule}>Unschedule</button>
          ) : null}
          <span className="spacer" />
          <button className="ghost-button" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
