"use client";

import { type ReactNode, useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CalendarDays, CalendarRange, CalendarX, Layers, LayoutGrid, List, Pencil, Wand2, X } from "lucide-react";
import type { AgendaCategoryOption, AgendaData, AgendaSession } from "@/lib/data/reads";
import { conflictedSessionIds, conflictSentences, findConflicts, placedSessions } from "@/lib/agenda-conflicts";
import { gridBounds, hourMarks, packLanes } from "@/lib/agenda-layout";
import { readableChip } from "@/lib/color-contrast";
import { publicationControl, unpublishedNotice } from "@/lib/agenda-publication";
import { applyRefusalCopy, fillOpenSlotsSummary } from "@/lib/agenda-autoplace-view";
import { boundedCount, boundedCountLabel } from "@/lib/bounded-count";
import {
  NO_TRACK_COLUMN_ID,
  groupByTrack,
  knownTrackIds,
  trackGridColumnFor,
  trackGridColumns,
  trackViewEmptyCopy,
} from "@/lib/agenda-track-view";
import { apiDelete, apiPatch, apiPost } from "@/lib/api-client";
import { EditSessionDialog } from "@/components/edit-session-dialog";
import { EmptyState, Pill } from "@/components/ui";
import {
  formatDayLabel,
  formatTime,
  minutesToTimeInput,
  tzAbbreviation,
  zonedParts,
  zonedToUtcIso,
} from "@/lib/tz";

/**
 * `"rooms"` is the day grid laid out in track columns. The id is a leftover from
 * when that grid had room columns and is kept as-is so nothing that persists a
 * view id has to be migrated; its tab is labelled "Track grid". `"tracks"` is
 * the programme-wide grouping added beside it.
 */
type View = "list" | "day" | "week" | "rooms" | "tracks" | "conflicts";

const PX_PER_MIN = 1;
/** Drop targets snap to 5-minute marks so dragging produces tidy start times. */
const SNAP_MINUTES = 5;

/** Local echo of a slot move while the server round-trip is in flight. */
type SlotOverride = { roomId: string; startsAt: string; endsAt: string };

/** What `POST /api/agenda/autoplace/preview` returns. Advisory, never authority. */
type PlacementPreview = {
  fingerprint: string;
  consideredSessions: number;
  placements: {
    sessionId: string;
    title: string;
    roomId: string;
    dayKey: string;
    startsAt: string;
    endsAt: string;
  }[];
  unplaceable: { sessionId: string; title: string; reason: string; message: string }[];
};

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

export function AgendaBuilder({
  data,
  /** This event's topics, for the edit dialog's picker. Empty is a real state:
   *  an event with no categories can still have its talks edited. */
  categoryOptions = [],
}: {
  data: AgendaData;
  categoryOptions?: AgendaCategoryOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [view, setView] = useState<View>("day");
  const [scheduling, setScheduling] = useState<AgendaSession | null>(null);
  // The talk whose content is open for editing, if any. Separate from
  // `scheduling` on purpose: one is where a talk sits, the other is what it says.
  const [editing, setEditing] = useState<AgendaSession | null>(null);
  const [overrides, setOverrides] = useState<Record<string, SlotOverride>>({});
  const [movingId, setMovingId] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PlacementPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Unscheduling used to report nothing at all: a refused DELETE left the block
  // sitting on the grid with no explanation, which reads exactly like a click
  // that never registered. Both outcomes are now stated.
  const [slotError, setSlotError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // One in-flight row mutation at a time, so a publish or unschedule trigger
  // cannot be double-fired while its request is still open.
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);

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
  // Derived once so the notice and the condition that renders it can never
  // describe different sets, and so the truncation flag is read in one place.
  const publicationNotice = unpublishedNotice(sessions.map((s) => s.contentStatus), data.truncated);

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
    setNotice(null);
    setRowBusyId(session.id);
    const res = await apiPatch("/api/agenda/sessions", {
      sessionId: session.id,
      contentStatus: control.next,
    });
    setRowBusyId(null);
    if (!res.ok) {
      setPublishError(res.error.message);
      return;
    }
    setNotice(
      control.next === "PUBLISHED"
        ? `“${session.title}” is now published — it appears on the public program.`
        : `“${session.title}” is now unpublished — it is withheld from the public program.`,
    );
    startTransition(() => router.refresh());
  }

  /**
   * Ask the server what it would place. This writes nothing — the plan comes
   * back for review and is applied, or discarded, by a second explicit action.
   */
  async function requestPlacementPreview() {
    setPreviewBusy(true);
    setPreviewError(null);
    const res = await apiPost<PlacementPreview>("/api/agenda/autoplace/preview", { eventId: data.eventId });
    setPreviewBusy(false);
    if (!res.ok) {
      setPreviewError(res.error.message);
      return;
    }
    setPreview(res.data);
  }

  /**
   * Apply the reviewed plan. The server re-reads and revalidates everything
   * under the schedule locks and can refuse the whole plan — a refusal writes
   * nothing, so the panel closes back to a clean grid and says why.
   */
  async function applyPlacementPreview(plan: PlacementPreview) {
    setPreviewBusy(true);
    setPreviewError(null);
    const res = await apiPost("/api/agenda/autoplace/apply", {
      eventId: data.eventId,
      fingerprint: plan.fingerprint,
      placements: plan.placements.map((p) => ({
        sessionId: p.sessionId,
        roomId: p.roomId,
        startsAt: p.startsAt,
        endsAt: p.endsAt,
      })),
    });
    setPreviewBusy(false);
    if (!res.ok) {
      // The stale plan is dead: it can only be re-derived, never retried.
      setPreview(null);
      setPreviewError(applyRefusalCopy(res.error.code, res.error.message));
      return;
    }
    setPreview(null);
    // The panel closing was the only signal that the plan had been written.
    // Name the count, because "complete plan or nothing" means this number is
    // exactly what landed on the grid.
    setNotice(
      `${plan.placements.length} talk${plan.placements.length === 1 ? " was" : "s were"} placed on the schedule.`,
    );
    startTransition(() => router.refresh());
  }

  /**
   * Take a talk off the schedule. The DELETE can be refused (a concurrent
   * write, a lost session, an expired role), and until now a refusal produced
   * nothing at all — the block simply stayed put, indistinguishable from a
   * click that never landed. Both outcomes now say what happened.
   */
  async function unschedule(sessionId: string, title?: string) {
    if (!window.confirm(`Unschedule${title ? ` “${title}”` : " this session"}?`)) return false;
    setSlotError(null);
    setNotice(null);
    setRowBusyId(sessionId);
    const res = await apiDelete(`/api/agenda/slots?sessionId=${encodeURIComponent(sessionId)}`);
    setRowBusyId(null);
    if (!res.ok) {
      setSlotError(res.error.message);
      return false;
    }
    setNotice(
      `${title ? `“${title}”` : "That talk"} was taken off the schedule. It is still a confirmed talk and can be placed again.`,
    );
    startTransition(() => router.refresh());
    return true;
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
      // `conflictDetails` names the room, the occupying talk, the time range
      // and the double-booked speaker; `conflicts` is the older type-and-code
      // list, kept as the fallback for a refusal whose slots could not be read.
      const detail = conflictSentences(res.error.fieldErrors).join(" · ");
      setMoveError(detail ? `${res.error.message} ${detail}` : res.error.message);
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div className="card">
      <div className="agenda-toolbar" role="group" aria-label="Agenda views">
        <ViewTab id="list" view={view} setView={setView} icon={<List size={15} />} label="List" />
        {/* Named for its columns, not just its span: this is the room grid, and
            it is the view that answers "what is in each room" (ROADMAP §6). */}
        <ViewTab id="day" view={view} setView={setView} icon={<CalendarDays size={15} />} label="Day (rooms)" />
        <ViewTab id="week" view={view} setView={setView} icon={<CalendarRange size={15} />} label="Week" />
        <ViewTab id="rooms" view={view} setView={setView} icon={<LayoutGrid size={15} />} label="Track grid" />
        <ViewTab id="tracks" view={view} setView={setView} icon={<Layers size={15} />} label="Tracks" />
        <ViewTab
          id="conflicts"
          view={view}
          setView={setView}
          icon={<AlertTriangle size={15} />}
          label={`Conflicts${conflicts.length ? ` (${boundedCount(conflicts.length, data.truncated)})` : ""}`}
        />
        <span className="spacer" />
        {/* Assistive, not primary: drag-and-drop remains the schedule editor,
            and this only ever proposes. Nothing is written until the plan it
            returns is reviewed and explicitly applied. */}
        <button
          className="ghost-button"
          disabled={previewBusy || pending}
          onClick={requestPlacementPreview}
          aria-label="Fill open slots — propose placements for the unscheduled backlog"
        >
          <Wand2 size={15} /> {previewBusy && !preview ? "Checking…" : "Fill open slots"}
        </button>
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

      {slotError && (
        <div style={{ padding: "12px 12px 0" }}>
          <div className="conflict-banner" role="alert">
            <AlertTriangle size={17} aria-hidden="true" />
            <div>
              <strong>Unschedule refused.</strong> {slotError} The talk is still on the schedule.{" "}
              <button className="link-button" onClick={() => setSlotError(null)}>Dismiss</button>
            </div>
          </div>
        </div>
      )}

      {/* The success half of the same contract: a write that changed the
          programme says so, rather than leaving the operator to infer it from a
          re-rendered grid. */}
      {notice && (
        <div style={{ padding: "12px 12px 0" }}>
          <div className="agenda-notice" role="status">
            <div>
              {notice}{" "}
              <button className="link-button" onClick={() => setNotice(null)}>Dismiss</button>
            </div>
          </div>
        </div>
      )}

      {previewError && (
        <div style={{ padding: "12px 12px 0" }}>
          <div className="conflict-banner" role="alert">
            <AlertTriangle size={17} aria-hidden="true" />
            <div>
              <strong>Nothing was placed.</strong> {previewError}{" "}
              <button className="link-button" onClick={() => setPreviewError(null)}>Dismiss</button>
            </div>
          </div>
        </div>
      )}

      {/* An operator laying out a partial programme must be told so: a conflict
          in the sessions this read never loaded is one the grid cannot warn
          about, and silence here would read as "no conflicts" (S20). */}
      {data.truncated ? (
        <div style={{ padding: "12px 12px 0" }}>
          <p className="hint" role="status">
            This event has more sessions than this page loads at once. The grid, the backlog and the conflict
            count below cover only the sessions listed here — reduce the event data to see the whole program.
          </p>
        </div>
      ) : null}

      {/* Says nothing at all when the whole programme is published, rather than
          reporting a reassuring zero. */}
      {publicationNotice ? (
        <div style={{ padding: "12px 12px 0" }}>
          <p className="hint" role="status">{publicationNotice}</p>
        </div>
      ) : null}

      {conflicts.length > 0 && view !== "conflicts" && (
        <div style={{ padding: 12 }}>
          <div className="conflict-banner">
            <AlertTriangle size={17} aria-hidden="true" />
            <div>
              {/* A floor past the cap: conflicts among sessions this read never
                  loaded are conflicts nothing here could have detected. */}
              <strong>
                {boundedCountLabel(conflicts.length, data.truncated, "scheduling conflict")} detected.
              </strong>{" "}
              <button className="link-button" onClick={() => setView("conflicts")}>Review conflicts</button>
            </div>
          </div>
        </div>
      )}

      {unscheduled.length > 0 && (
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
          <p className="field-label" style={{ marginBottom: 8 }}>
            Unscheduled backlog <span className="hint">({boundedCount(unscheduled.length, data.truncated)})</span>
          </p>
          <div className="row wrap" style={{ gap: 8 }}>
            {unscheduled.map((s) => (
              /* Two actions, two buttons: a nested one would be invalid HTML,
                 and an accepted talk in the backlog is exactly the one whose
                 title an organizer is most likely to have to fix before it goes
                 anywhere near the public program. */
              <span className="row" style={{ gap: 4 }} key={s.id}>
                <button className="ghost-button" onClick={() => setScheduling(s)}>
                  {s.title}{" "}
                  <span className="hint">
                    · {s.durationMinutes}m{s.category ? ` · ${s.category.name}` : ""}
                  </span>
                </button>
                <button
                  className="ghost-button"
                  onClick={() => setEditing(s)}
                  aria-label={`Edit “${s.title}”`}
                >
                  <Pencil size={14} aria-hidden="true" />
                </button>
              </span>
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
          onEdit={setEditing}
          onUnschedule={unschedule}
          onPublication={setPublication}
          busy={pending}
          busyId={rowBusyId}
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
              // Columns are derived from the placed talks as well as the track
              // list, so an untracked talk gets a column to render in instead
              // of matching none and disappearing.
              : trackGridColumns(data.tracks, placed)
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
      {view === "tracks" && (
        <TracksView
          sessions={placed}
          tz={tz}
          tracks={data.tracks}
          conflictIds={conflictIds}
          roomName={roomName}
          onSelect={setScheduling}
        />
      )}
      {view === "conflicts" && (
        <ConflictsView
          conflicts={conflicts}
          sessions={sessions}
          tz={tz}
          truncated={data.truncated}
          onSelect={setScheduling}
        />
      )}

      {preview ? (
        <FillOpenSlotsDialog
          preview={preview}
          tz={tz}
          roomName={roomName}
          busy={previewBusy}
          onApply={() => applyPlacementPreview(preview)}
          onDiscard={() => setPreview(null)}
        />
      ) : null}

      {/* Content, not placement: the server re-reads the talk under this event's
          scope and can refuse, and the grid is re-read from it afterwards rather
          than patched, so what shows here is what the public surfaces will read. */}
      {editing ? (
        <EditSessionDialog
          session={editing}
          categoryOptions={categoryOptions}
          onClose={() => setEditing(null)}
          onSaved={(savedTitle) => {
            setEditing(null);
            setNotice(`“${savedTitle}” was updated. Its schedule and speakers are unchanged.`);
            startTransition(() => router.refresh());
          }}
        />
      ) : null}

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
  onEdit,
  onUnschedule,
  onPublication,
  busy,
  busyId,
}: {
  sessions: Placed[];
  tz: string;
  conflictIds: Set<string>;
  roomName: (id: string) => string;
  trackColor: (id: string | null) => string;
  onReschedule: (s: AgendaSession) => void;
  onEdit: (s: AgendaSession) => void;
  onUnschedule: (id: string, title?: string) => void;
  onPublication: (s: AgendaSession) => void;
  busy: boolean;
  /** The one row with a publish/unschedule request open, if any. */
  busyId: string | null;
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
          {/* Both row writes are gated on `busyId`, not just the transition:
              `pending` only begins after a successful response, so before this
              a second click landed a second request while the first was open. */}
          <button
            className="ghost-button"
            disabled={busy || busyId !== null}
            onClick={() => onPublication(s)}
            aria-label={publicationControl(s.contentStatus).actionLabel(s.title)}
          >
            {busyId === s.id ? "Working…" : publicationControl(s.contentStatus).label}
          </button>
          <button className="ghost-button" onClick={() => onReschedule(s)}>Move</button>
          {/* The talk's own content — title, summary, format, length, topic.
              Distinct from "Move", which is where it sits, and from the
              Speakers page, which is who presents it. */}
          <button className="ghost-button" onClick={() => onEdit(s)} aria-label={`Edit “${s.title}”`}>
            <Pencil size={15} aria-hidden="true" /> Edit
          </button>
          <button className="ghost-button danger-button" disabled={busy || busyId !== null} onClick={() => onUnschedule(s.id, s.title)} aria-label={`Unschedule ${s.title}`}>
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
  // Recovered from the columns rather than passed in: the untracked column is
  // the one column whose id is not a track id, so the set the filter needs is
  // exactly the rest of them. Only read when `groupBy` is "track".
  const known = knownTrackIds(columns.filter((c) => c.id !== NO_TRACK_COLUMN_ID));

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
                .filter((s) =>
                  groupBy === "room"
                    ? s.slot.roomId === col.id
                    : trackGridColumnFor(s.slot.trackId, known) === col.id,
                )
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

/**
 * Read-only programme-wide grouping by track.
 *
 * The track grid beside it answers "what is running at 10am on Tuesday"; this
 * answers "what is this track, end to end", so it spans every day at once and
 * names the room and time on each row instead of drawing them. Read-only for
 * the same reason the week view is: a column here is not a bookable resource,
 * and scheduling stays behind the dialog where the server can refuse it.
 *
 * Grouping, ordering and the empty copy all come from `lib/agenda-track-view`,
 * so what this renders is what that module's tests assert.
 */
function TracksView({
  sessions,
  tz,
  tracks,
  conflictIds,
  roomName,
  onSelect,
}: {
  sessions: Placed[];
  tz: string;
  tracks: AgendaData["tracks"];
  conflictIds: Set<string>;
  roomName: (id: string) => string;
  onSelect: (s: AgendaSession) => void;
}) {
  const groups = groupByTrack(sessions, tracks);
  const empty = trackViewEmptyCopy(groups);
  const ids = useId();

  if (empty) {
    return <EmptyState icon={<Layers size={22} />} title={empty.title}>{empty.detail}</EmptyState>;
  }

  return (
    <div>
      {/* With no tracks configured the whole programme sits under one grey "No
          track" heading, which reads as a broken view rather than as a setting
          the organizer has not filled in yet. Named, so it reads as the latter. */}
      {tracks.length === 0 ? (
        <p className="hint" role="status" style={{ padding: "12px 16px 0" }}>
          This event has no tracks, so every scheduled talk is listed under “No track”. Add tracks in event
          settings to group the program.
        </p>
      ) : null}
      {groups.map((group) => {
        const headingId = `${ids}-${group.trackId ?? "untracked"}`;
        return (
          <section key={group.trackId ?? "untracked"} aria-labelledby={headingId}>
            <div className="agenda-track-head">
              <span className="track-dot" style={{ background: group.color }} aria-hidden="true" />
              <h3 id={headingId}>{group.name}</h3>
              <span className="hint">
                {group.sessions.length === 1 ? "1 talk" : `${group.sessions.length} talks`}
              </span>
            </div>
            {/* A track an organizer created and never filled is a real state of
                the programme, so it is named rather than left off the page. */}
            {group.sessions.length === 0 ? (
              <p className="hint agenda-track-empty">
                {group.trackId === null
                  ? "Nothing is scheduled without a track."
                  : "Nothing is scheduled in this track yet."}
              </p>
            ) : (
              group.sessions.map((s) => (
                <button
                  key={s.id}
                  className="agenda-list-item agenda-track-item"
                  onClick={() => onSelect(s)}
                  // No aria-label: the row's own text is the richer name, and
                  // overriding it here would hide the time, room and speakers
                  // from a screen reader that can currently hear all three.
                  title={`Open the scheduler for “${s.title}”`}
                >
                  <span className="time">
                    {formatTime(s.slot.startsAt, tz)}–{formatTime(s.slot.endsAt, tz)}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="cell-title">{s.title}</span>
                    <span className="cell-sub">
                      {formatDayLabel(zonedParts(s.slot.startsAt, tz).dateKey, tz)} ·{" "}
                      {roomName(s.slot.roomId)} ·{" "}
                      {s.speakers.map((sp) => sp.name).join(", ") || "No speakers"}
                    </span>
                  </span>
                  {conflictIds.has(s.id) ? <Pill tone="bad"><AlertTriangle size={12} /> Conflict</Pill> : null}
                  {/* Same statement the list view makes: an unpublished talk sits
                      in this grouping but is withheld from the public programme. */}
                  {s.contentStatus === "DRAFT" ? <Pill tone="neutral">Unpublished</Pill> : null}
                </button>
              ))
            )}
          </section>
        );
      })}
    </div>
  );
}

function ConflictsView({
  conflicts,
  sessions,
  tz,
  truncated,
  onSelect,
}: {
  conflicts: ReturnType<typeof findConflicts>;
  sessions: AgendaSession[];
  tz: string;
  truncated: boolean;
  onSelect: (s: AgendaSession) => void;
}) {
  if (conflicts.length === 0) {
    // "Every room and speaker has a clear schedule" is a claim about the whole
    // programme. Past the cap this view has not seen the whole programme, so it
    // reports what it actually checked instead of clearing the event.
    return truncated ? (
      <EmptyState icon={<AlertTriangle size={22} />} title="No conflicts in the sessions loaded here">
        This event is larger than this page loads at once, so this is not a clear bill of health for the
        whole schedule — reduce the event data to check every session.
      </EmptyState>
    ) : (
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

/**
 * GRA2-06 — the shared modal shell for this screen's two dialogs.
 *
 * `showModal()` gives the focus trap, Escape handling, an inert background and
 * focus restoration to whatever opened it, the same pattern as the CFP
 * "New form" and speaker dialogs, so nothing here hand-rolls a trap. Both
 * dialogs mount only on a click, so there is no server-rendered open state to
 * reconcile — the effect can open unconditionally.
 *
 * Padding lives on the body rather than the dialog so that a mousedown landing
 * on the dialog element itself is unambiguously a backdrop click, and a write
 * in flight blocks both dismissal routes rather than discarding it.
 */
function AgendaDialog({
  className,
  labelledBy,
  busy,
  onClose,
  children,
}: {
  className: string;
  /** Space-separated ids of the dialog's own visible heading text. */
  labelledBy: string;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className={`card agenda-dialog ${className}`}
      aria-labelledby={labelledBy}
      onClose={onClose}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      onMouseDown={(event) => {
        if (event.target === dialogRef.current && !busy) onClose();
      }}
    >
      <div className="agenda-dialog-body">{children}</div>
    </dialog>
  );
}

/**
 * The proposed plan, shown before anything is written (AIA-08, addendum §4.1).
 *
 * Every talk the server considered appears here exactly once — placed, with the
 * room and time it would take, or listed with the reason it could not be. There
 * is no path from this panel to a write except the Apply button, and the server
 * revalidates the whole plan again when that is pressed.
 */
function FillOpenSlotsDialog({
  preview,
  tz,
  roomName,
  busy,
  onApply,
  onDiscard,
}: {
  preview: PlacementPreview;
  tz: string;
  roomName: (id: string) => string;
  busy: boolean;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const summary = fillOpenSlotsSummary(preview);
  const ids = useId();
  return (
    <AgendaDialog
      className="agenda-preview-dialog"
      // The eyebrow and the heading are the dialog's own visible title line;
      // together they name it the way the screen reads.
      labelledBy={`${ids}-eyebrow ${ids}-title`}
      busy={busy}
      onClose={onDiscard}
    >
      <>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <p className="eyebrow" id={`${ids}-eyebrow`}>Fill open slots — nothing saved yet</p>
          <button type="button" className="ghost-button" onClick={onDiscard} aria-label="Close"><X size={16} /></button>
        </div>
        <h2 id={`${ids}-title`} style={{ margin: "0 0 4px" }}>{summary.title}</h2>
        {summary.detail ? <p className="hint">{summary.detail}</p> : null}

        {preview.placements.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <p className="field-label" style={{ marginBottom: 8 }}>Proposed placements</p>
            <div>
              {preview.placements.map((p) => (
                <div className="agenda-list-item" key={p.sessionId}>
                  <span className="time">
                    {formatTime(p.startsAt, tz)}–{formatTime(p.endsAt, tz)}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="cell-title">{p.title}</div>
                    <div className="cell-sub">
                      {formatDayLabel(p.dayKey, tz)} · {roomName(p.roomId)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Reported, never dropped: a talk the scheduler skipped in silence is
            a talk an organizer will discover on the day. */}
        {preview.unplaceable.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <p className="field-label" style={{ marginBottom: 8 }}>
              Could not be placed ({preview.unplaceable.length})
            </p>
            <div style={{ display: "grid", gap: 8 }}>
              {preview.unplaceable.map((u) => (
                <div key={u.sessionId} className="conflict-banner" style={{ flexDirection: "column", alignItems: "flex-start" }}>
                  <strong>{u.title}</strong>
                  <span className="hint" style={{ color: "#8a2f22" }}>{u.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <p className="hint" style={{ marginTop: 16 }}>
          Applying places these talks in one step and changes nothing that is already scheduled. It does not
          publish anything — an unpublished talk stays off the public agenda until you publish it. If another
          organizer changes the schedule first, the whole plan is refused and you can generate a new one.
        </p>

        <div className="row wrap" style={{ marginTop: 18, gap: 8 }}>
          {summary.canApply ? (
            <button className="primary-button" disabled={busy} onClick={onApply}>
              {busy ? "Placing…" : `Apply ${preview.placements.length === 1 ? "placement" : "placements"}`}
            </button>
          ) : null}
          <span className="spacer" />
          <button type="button" className="ghost-button" disabled={busy} onClick={onDiscard}>
            {summary.canApply ? "Discard" : "Close"}
          </button>
        </div>
      </>
    </AgendaDialog>
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
  const ids = useId();

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
      // Prefer the server's named sentences ("Room conflict: Hall A is occupied
      // by “…” from 10:00 AM–10:45 AM PDT.") over the coded list.
      setConflictDetail(conflictSentences(res.error.fieldErrors));
      return;
    }
    onSaved();
  }

  return (
    <AgendaDialog
      className="agenda-schedule-dialog"
      // "Move session" / "Schedule session" plus the talk's title — the same
      // two lines the previous aria-label spelled out, now taken from the
      // visible text so the two cannot drift.
      labelledBy={`${ids}-eyebrow ${ids}-title`}
      busy={busy}
      onClose={onClose}
    >
      <>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <p className="eyebrow" id={`${ids}-eyebrow`}>{existing ? "Move session" : "Schedule session"}</p>
          <button type="button" className="ghost-button" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <h2 id={`${ids}-title`} style={{ margin: "0 0 4px" }}>{session.title}</h2>
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
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
        </div>
      </>
    </AgendaDialog>
  );
}
