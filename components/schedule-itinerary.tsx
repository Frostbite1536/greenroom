"use client";

/**
 * "My itinerary" — the only interactive part of the public schedule.
 *
 * The schedule around this file stays server-rendered on purpose (see
 * components/embed-schedule.tsx): day tabs, the track filter and search are
 * links and a GET form. So this is deliberately three small leaves sharing one
 * module-level store rather than a client rewrite of the page:
 *
 *   - `ItineraryStar`    one per session card, inside otherwise-server markup
 *   - `ItineraryTab`     the "My itinerary (N)" filter beside the day tabs
 *   - `ItineraryView`    wraps the server-rendered day sections
 *
 * Why a module store and not React context: a context provider would have to
 * wrap the whole page, and the leaves would then depend on that wrapper being
 * in place on both surfaces. A store subscribed to with `useSyncExternalStore`
 * lets each leaf be independent, keeps `getServerSnapshot` honestly empty (the
 * server cannot know a reader's localStorage), and never mutates on the server.
 *
 * Why `ItineraryView` swaps the server subtree instead of hiding cards with
 * CSS: the starred set is only known client-side, so *something* must render
 * client-side. Passing the server-rendered sections through as `children` and
 * rendering `{mode === "itinerary" ? <list/> : children}` keeps that SSR markup
 * intact and instantly restorable — no DOM walking, no injected stylesheet, and
 * an empty day heading can never be left behind above a hidden card. The
 * itinerary rows themselves are built from a slim projection of the same agenda
 * the page already rendered, so no extra request is made.
 *
 * Progressive enhancement: every piece renders `null` until it has mounted, so
 * the server HTML — and therefore the page with JavaScript disabled — is
 * byte-identical to the schedule before this feature existed.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { CalendarPlus, Star, X } from "lucide-react";
import { formatDayLabel, formatTimeRange, zonedParts } from "@/lib/tz";
import { itineraryExportUrl } from "@/lib/ics-embed";
import {
  itineraryOverlaps,
  itinerarySessions,
  itineraryTabLabel,
  overlapNotice,
  readItinerary,
  toggleItineraryId,
  writeItinerary,
  type ItinerarySession,
} from "@/lib/itinerary";

type Mode = "schedule" | "itinerary";

type StoreState = {
  /** The event this state belongs to; a mismatch forces a reload from storage. */
  eventKey: string;
  ids: readonly string[];
  mode: Mode;
  loaded: boolean;
};

const EMPTY: StoreState = Object.freeze({ eventKey: "", ids: Object.freeze([]), mode: "schedule" as Mode, loaded: false });

let state: StoreState = EMPTY;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function setState(next: StoreState) {
  state = next;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): StoreState {
  return state;
}

/** The server has no reader, so it always sees an empty, schedule-mode page. */
function getServerSnapshot(): StoreState {
  return EMPTY;
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch (error) {
    // Storage access itself throws under some privacy settings.
    console.error("Itinerary browser storage access failed", error);
    return null;
  }
}

/** Idempotent: whichever leaf mounts first loads the reader's stored set. */
function loadItinerary(eventKey: string) {
  if (state.loaded && state.eventKey === eventKey) return;
  setState({ eventKey, ids: readItinerary(browserStorage(), eventKey), mode: "schedule", loaded: true });
}

function useItinerary(eventKey: string) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // Mount-gated rather than rendered on the server: see the file comment.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    loadItinerary(eventKey);
    setMounted(true);
    // Another tab starring the same programme should not leave this one lying.
    const onStorage = () => {
      setState({ ...state, eventKey, ids: readItinerary(browserStorage(), eventKey), loaded: true });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [eventKey]);

  const active = snapshot.eventKey === eventKey ? snapshot : EMPTY;
  return { mounted, ids: active.ids, mode: active.mode };
}

function toggle(eventKey: string, sessionId: string) {
  const current = state.eventKey === eventKey ? state.ids : readItinerary(browserStorage(), eventKey);
  const ids = toggleItineraryId(current, sessionId);
  writeItinerary(browserStorage(), eventKey, ids);
  setState({ eventKey, ids, mode: state.eventKey === eventKey ? state.mode : "schedule", loaded: true });
}

function setMode(eventKey: string, mode: Mode) {
  if (state.loaded && state.eventKey === eventKey) {
    setState({ ...state, mode });
    return;
  }
  setState({ eventKey, ids: readItinerary(browserStorage(), eventKey), mode, loaded: true });
}

/**
 * The per-card toggle. A leaf inside a server-rendered `<article>`: the card's
 * title, times, chips and details are all still HTML from the server.
 */
export function ItineraryStar({
  eventKey,
  sessionId,
  title,
}: {
  eventKey: string;
  sessionId: string;
  title: string;
}) {
  const { mounted, ids } = useItinerary(eventKey);
  const starred = ids.includes(sessionId);
  const onClick = useCallback(() => toggle(eventKey, sessionId), [eventKey, sessionId]);

  if (!mounted) return null;

  return (
    <button
      type="button"
      className="ghost-button itinerary-star"
      aria-pressed={starred}
      onClick={onClick}
    >
      <Star size={14} aria-hidden="true" fill={starred ? "currentColor" : "none"} />
      {/* The session title is in the accessible name, so a screen-reader user
          moving button to button is never told only "Add to itinerary". */}
      <span aria-hidden="true">{starred ? "In my itinerary" : "Add to itinerary"}</span>
      <span className="sr-only">
        {starred ? `Remove ${title} from my itinerary` : `Add ${title} to my itinerary`}
      </span>
    </button>
  );
}

/** The "My itinerary (N)" filter, rendered beside the server day tabs. */
export function ItineraryTab({ eventKey }: { eventKey: string }) {
  const { mounted, ids, mode } = useItinerary(eventKey);
  const onClick = useCallback(
    () => setMode(eventKey, state.mode === "itinerary" ? "schedule" : "itinerary"),
    [eventKey],
  );

  // The island owns its own `<nav>` so that with JavaScript disabled the header
  // emits no empty landmark — the page is exactly the one shipped before this.
  if (!mounted) return null;

  return (
    <nav className="embed-filters itinerary-filters" aria-label="My itinerary">
      <button
        type="button"
        className="ghost-button itinerary-tab"
        aria-pressed={mode === "itinerary"}
        onClick={onClick}
      >
        <Star size={14} aria-hidden="true" fill={ids.length > 0 ? "currentColor" : "none"} />
        {itineraryTabLabel(ids.length)}
      </button>
      {mode === "itinerary" ? (
        <span className="hint itinerary-mode-note">Showing your starred sessions only</span>
      ) : null}
    </nav>
  );
}

function ItineraryRow({
  session,
  overlaps,
  timeZone,
  onRemove,
}: {
  session: ItinerarySession;
  overlaps: string[] | undefined;
  timeZone: string;
  onRemove: () => void;
}) {
  const notice = overlapNotice(overlaps);
  return (
    <article className="embed-session itinerary-row">
      <span className="rail" style={{ background: session.trackColor ?? "#687276" }} aria-hidden="true" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <h3>{session.title}</h3>
        <div className="meta">
          <span>{formatTimeRange(session.startsAt, session.endsAt, timeZone)}</span>
          <span>{session.roomName}</span>
          {session.trackName ? <span>{session.trackName}</span> : null}
        </div>
        {/* A clash is stated in words, not signalled by colour alone, and is a
            warning rather than an error: choosing two overlapping talks is a
            legitimate thing for an attendee to do on purpose. */}
        {/* Deliberately not a live region: entering itinerary mode renders every
            row at once, and a polite announcement per clash would talk over the
            reader. It is read in document order like any other sentence. */}
        {notice ? <p className="itinerary-overlap">{notice}</p> : null}
      </div>
      <button type="button" className="ghost-button itinerary-remove" onClick={onRemove}>
        <X size={14} aria-hidden="true" />
        <span className="sr-only">{`Remove ${session.title} from my itinerary`}</span>
      </button>
    </article>
  );
}

/**
 * Swaps the server-rendered day sections for the reader's own itinerary.
 *
 * `children` is the untouched server subtree; in schedule mode it is returned
 * exactly as delivered.
 */
export function ItineraryView({
  eventKey,
  eventId,
  timeZone,
  sessions,
  children,
}: {
  eventKey: string;
  eventId: string;
  timeZone: string;
  /** Slim projection of the same agenda the page rendered — no descriptions. */
  sessions: readonly ItinerarySession[];
  children: ReactNode;
}) {
  const { mounted, ids, mode } = useItinerary(eventKey);

  const chosen = useMemo(() => itinerarySessions(sessions, ids), [sessions, ids]);
  const overlaps = useMemo(() => itineraryOverlaps(chosen), [chosen]);
  const days = useMemo(() => {
    const map = new Map<string, ItinerarySession[]>();
    for (const session of chosen) {
      const key = zonedParts(session.startsAt, timeZone).dateKey;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(session);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [chosen, timeZone]);

  if (!mounted || mode !== "itinerary") return <>{children}</>;

  const icsUrl = itineraryExportUrl(eventId, chosen.map((session) => session.sessionId));

  return (
    <div className="itinerary-panel">
      {chosen.length === 0 ? (
        <p className="hint" role="status">
          Nothing starred yet. Use “Add to itinerary” on a session to build your own schedule — it
          is kept in this browser only, on this device.
        </p>
      ) : (
        <>
          <div className="row wrap" style={{ justifyContent: "space-between", gap: 8 }}>
            <p className="hint" role="status">
              {`${chosen.length} ${chosen.length === 1 ? "session" : "sessions"} starred in this browser.`}
            </p>
            {icsUrl ? (
              <a className="ghost-button" href={icsUrl} style={{ textDecoration: "none" }}>
                <CalendarPlus size={15} aria-hidden="true" /> Download my itinerary (.ics)
              </a>
            ) : null}
          </div>
          {days.map(([dayKey, items]) => (
            <section key={dayKey}>
              <h2 className="time-heading" style={{ fontSize: 13 }}>{formatDayLabel(dayKey, timeZone)}</h2>
              {items.map((session) => (
                <ItineraryRow
                  key={session.sessionId}
                  session={session}
                  overlaps={overlaps.get(session.sessionId)}
                  timeZone={timeZone}
                  onRemove={() => toggle(eventKey, session.sessionId)}
                />
              ))}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
