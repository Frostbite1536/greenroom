"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Building2, CalendarDays, Plus, Tags, Trash2 } from "lucide-react";
import type { EventSettingsView } from "@/lib/data/reads";
import { apiDelete, apiPatch, apiPost, firstFieldErrors } from "@/lib/api-client";
import {
  COMMON_TIME_ZONES,
  eventSettingsDraft,
  planCategoryPatch,
  planEventSettingsPatch,
  planRoomPatch,
  planTrackPatch,
  reconcileEventSettingsDraft,
  validateEventDatePair,
  type CategoryRowAuthority,
  type EventSettingsDraft,
  type RoomRowAuthority,
  type TrackRowAuthority,
} from "@/lib/event-settings-form";
import { normalizeHex } from "@/lib/color-contrast";
import { EmptyState, Pill } from "@/components/ui";

type EventForm = EventSettingsDraft;

type RoomDraft = { id: string; name: string; capacity: string; loaded: RoomRowAuthority };
/**
 * A row draft carries the row exactly as it was loaded. The save diffs against
 * that `loaded` snapshot rather than against the current RSC payload: a field
 * the operator never touched must be omitted from the PATCH even when a
 * colleague has already changed it server-side, which is precisely the case a
 * diff against current truth would get wrong.
 */
type TrackDraft = { id: string; name: string; color: string; loaded: TrackRowAuthority };
type CategoryDraft = {
  id: string;
  name: string;
  description: string;
  defaultTeamKey: string;
  loaded: CategoryRowAuthority;
};
type EventError = { message: string; field: "name" | "timezone" | "dates" | "general" };

type TrackView = EventSettingsView["tracks"][number];
type CategoryView = EventSettingsView["categories"][number];

/** The seeded Mainstage colour: a sensible first swatch, not a constraint. */
const DEFAULT_TRACK_COLOUR = "#6366f1";

function positiveCapacity(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function EventSettings({ view }: { view: EventSettingsView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const initialEvent = eventSettingsDraft(view.event);
  const [event, setEvent] = useState(() => initialEvent);
  const eventBaselineRef = useRef(initialEvent);
  const eventDraftRef = useRef(initialEvent);
  const eventIdRef = useRef(view.event.id);
  const [eventError, setEventError] = useState<EventError | null>(null);
  const [eventNotice, setEventNotice] = useState<string | null>(null);
  const [savingEvent, setSavingEvent] = useState(false);
  const [newRoomName, setNewRoomName] = useState("");
  const [newRoomCapacity, setNewRoomCapacity] = useState("");
  const [roomError, setRoomError] = useState<string | null>(null);
  const [roomNotice, setRoomNotice] = useState<string | null>(null);
  const [roomBusy, setRoomBusy] = useState<string | null>(null);
  const [editingRoom, setEditingRoom] = useState<RoomDraft | null>(null);
  const [newTrackName, setNewTrackName] = useState("");
  const [newTrackColour, setNewTrackColour] = useState(DEFAULT_TRACK_COLOUR);
  const [trackError, setTrackError] = useState<string | null>(null);
  const [trackNotice, setTrackNotice] = useState<string | null>(null);
  const [trackBusy, setTrackBusy] = useState<string | null>(null);
  const [editingTrack, setEditingTrack] = useState<TrackDraft | null>(null);
  const [categoryName, setCategoryName] = useState("");
  const [categoryDescription, setCategoryDescription] = useState("");
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [categoryNotice, setCategoryNotice] = useState<string | null>(null);
  const [categoryBusy, setCategoryBusy] = useState<string | null>(null);
  const [editingCategory, setEditingCategory] = useState<CategoryDraft | null>(null);

  const applyAuthoritativeEvent = useCallback((
    authoritative: EventSettingsView["event"],
    submittedDraft?: EventForm,
  ) => {
    const reconciliation = reconcileEventSettingsDraft(
      eventBaselineRef.current,
      eventDraftRef.current,
      authoritative,
      submittedDraft,
    );
    eventBaselineRef.current = reconciliation.baseline;
    eventDraftRef.current = reconciliation.draft;
    setEvent((current) => current.name === reconciliation.draft.name
      && current.timezone === reconciliation.draft.timezone
      && current.startsOn === reconciliation.draft.startsOn
      && current.endsOn === reconciliation.draft.endsOn
      ? current
      : reconciliation.draft);
  }, []);

  // Room/category mutations refresh the whole RSC payload. Depend only on
  // event scalars, then reconcile that new server truth with the local draft.
  // A different event is a real scope change, so it intentionally starts clean.
  useEffect(() => {
    if (eventIdRef.current !== view.event.id) {
      const next = eventSettingsDraft(view.event);
      eventIdRef.current = view.event.id;
      eventBaselineRef.current = next;
      eventDraftRef.current = next;
      setEvent(next);
      return;
    }
    applyAuthoritativeEvent(view.event);
  }, [applyAuthoritativeEvent, view.event.id, view.event.name, view.event.timezone, view.event.startsOn, view.event.endsOn]);

  function updateEvent(field: keyof EventForm, value: string) {
    const next = { ...eventDraftRef.current, [field]: value };
    eventDraftRef.current = next;
    setEvent(next);
  }

  function refresh() {
    startTransition(() => router.refresh());
  }

  async function saveEvent() {
    const submittedDraft = eventDraftRef.current;
    const dateError = validateEventDatePair(submittedDraft.startsOn, submittedDraft.endsOn);
    if (dateError) {
      setEventError({ message: dateError, field: "dates" });
      return;
    }
    const patch = planEventSettingsPatch(submittedDraft, eventBaselineRef.current);
    if (!patch) {
      setEventError(null);
      setEventNotice("No event details have changed.");
      return;
    }
    setSavingEvent(true);
    setEventError(null);
    setEventNotice(null);
    const res = await apiPatch<{ event: EventSettingsView["event"] }>("/api/admin/settings", patch);
    setSavingEvent(false);
    if (!res.ok) {
      const fields = firstFieldErrors(res.error.fieldErrors);
      const dateMessage = fields.startsOn ?? fields.endsOn;
      if (dateMessage) {
        setEventError({ message: dateMessage, field: "dates" });
      } else if (fields.timezone) {
        setEventError({ message: fields.timezone, field: "timezone" });
      } else if (fields.name) {
        setEventError({ message: fields.name, field: "name" });
      } else {
        setEventError({ message: res.error.message, field: "general" });
      }
      return;
    }
    applyAuthoritativeEvent(res.data.event, submittedDraft);
    setEventNotice("Event details saved.");
    refresh();
  }

  async function addRoom() {
    const capacity = positiveCapacity(newRoomCapacity);
    if (!newRoomName.trim()) {
      setRoomError("Give the room a name.");
      return;
    }
    if (capacity === null) {
      setRoomError("Capacity must be a whole number greater than zero.");
      return;
    }
    setRoomBusy("new");
    setRoomError(null);
    setRoomNotice(null);
    const res = await apiPost<{ room: EventSettingsView["rooms"][number] }>("/api/admin/settings/rooms", {
      name: newRoomName.trim(),
      ...(capacity === undefined ? {} : { capacity }),
    });
    setRoomBusy(null);
    if (!res.ok) {
      const fields = firstFieldErrors(res.error.fieldErrors);
      setRoomError(fields.name ?? fields.capacity ?? res.error.message);
      return;
    }
    setNewRoomName("");
    setNewRoomCapacity("");
    setRoomNotice(`Added ${res.data.room.name}.`);
    refresh();
  }

  async function saveRoom() {
    if (!editingRoom) return;
    const capacity = positiveCapacity(editingRoom.capacity);
    if (!editingRoom.name.trim()) {
      setRoomError("Give the room a name.");
      return;
    }
    if (capacity === null) {
      setRoomError("Capacity must be a whole number greater than zero, or leave it empty.");
      return;
    }
    // Only what this operator actually changed, diffed against the row as it
    // was loaded, so a colleague's capacity change survives a rename here.
    const patch = planRoomPatch({ name: editingRoom.name, capacity: capacity ?? null }, editingRoom.loaded);
    if (!patch) {
      setEditingRoom(null);
      setRoomError(null);
      setRoomNotice("No room details have changed.");
      return;
    }
    setRoomBusy(editingRoom.id);
    setRoomError(null);
    setRoomNotice(null);
    const res = await apiPatch<{ room: EventSettingsView["rooms"][number] }>("/api/admin/settings/rooms", {
      id: editingRoom.id,
      ...patch,
    });
    setRoomBusy(null);
    if (!res.ok) {
      const fields = firstFieldErrors(res.error.fieldErrors);
      setRoomError(fields.name ?? fields.capacity ?? res.error.message);
      return;
    }
    setEditingRoom(null);
    setRoomNotice(`Saved ${res.data.room.name}.`);
    refresh();
  }

  async function removeRoom(room: EventSettingsView["rooms"][number]) {
    if (!window.confirm(`Remove “${room.name}”? This is only available when no sessions use the room.`)) return;
    setRoomBusy(`delete:${room.id}`);
    setRoomError(null);
    setRoomNotice(null);
    const res = await apiDelete<{ room: EventSettingsView["rooms"][number] }>(
      `/api/admin/settings/rooms?roomId=${encodeURIComponent(room.id)}`,
    );
    setRoomBusy(null);
    if (!res.ok) {
      // Never remove the row locally: a 409 means it remains real event data.
      setRoomError(res.error.message);
      return;
    }
    setRoomNotice(`Removed ${res.data.room.name}.`);
    refresh();
  }

  async function addTrack() {
    if (!newTrackName.trim()) {
      setTrackError("Give the track a name.");
      return;
    }
    setTrackBusy("new");
    setTrackError(null);
    setTrackNotice(null);
    const res = await apiPost<{ track: TrackView }>("/api/admin/settings/tracks", {
      name: newTrackName.trim(),
      color: newTrackColour,
    });
    setTrackBusy(null);
    if (!res.ok) {
      const fields = firstFieldErrors(res.error.fieldErrors);
      setTrackError(fields.name ?? fields.color ?? res.error.message);
      return;
    }
    setNewTrackName("");
    setNewTrackColour(DEFAULT_TRACK_COLOUR);
    setTrackNotice(`Added ${res.data.track.name}.`);
    refresh();
  }

  async function saveTrack() {
    if (!editingTrack) return;
    if (!editingTrack.name.trim()) {
      setTrackError("Give the track a name.");
      return;
    }
    // Only what this operator actually changed, diffed against the row as it
    // was loaded, so a colleague's colour change survives a rename here.
    const patch = planTrackPatch(editingTrack, editingTrack.loaded);
    if (!patch) {
      setEditingTrack(null);
      setTrackError(null);
      setTrackNotice("No track details have changed.");
      return;
    }
    setTrackBusy(editingTrack.id);
    setTrackError(null);
    setTrackNotice(null);
    const res = await apiPatch<{ track: TrackView }>("/api/admin/settings/tracks", {
      id: editingTrack.id,
      ...patch,
    });
    setTrackBusy(null);
    if (!res.ok) {
      const fields = firstFieldErrors(res.error.fieldErrors);
      setTrackError(fields.name ?? fields.color ?? res.error.message);
      return;
    }
    setEditingTrack(null);
    setTrackNotice(`Saved ${res.data.track.name}.`);
    refresh();
  }

  async function removeTrack(track: TrackView) {
    if (!window.confirm(`Remove “${track.name}”? This is only available when no sessions are scheduled on the track.`)) return;
    setTrackBusy(`delete:${track.id}`);
    setTrackError(null);
    setTrackNotice(null);
    const res = await apiDelete<{ track: TrackView }>(
      `/api/admin/settings/tracks?trackId=${encodeURIComponent(track.id)}`,
    );
    setTrackBusy(null);
    if (!res.ok) {
      // Never remove the row locally: a 409 means it remains real event data.
      setTrackError(res.error.message);
      return;
    }
    setTrackNotice(`Removed ${res.data.track.name}.`);
    refresh();
  }

  async function addCategory() {
    if (!categoryName.trim()) {
      setCategoryError("Give the category a name.");
      return;
    }
    setCategoryBusy("new");
    setCategoryError(null);
    setCategoryNotice(null);
    const res = await apiPost<{ id: string; name: string }>("/api/cfp/categories", {
      eventId: view.event.id,
      name: categoryName.trim(),
      ...(categoryDescription.trim() ? { description: categoryDescription.trim() } : {}),
      sortOrder: 0,
    });
    setCategoryBusy(null);
    if (!res.ok) {
      const fields = firstFieldErrors(res.error.fieldErrors);
      setCategoryError(fields.name ?? fields.description ?? res.error.message);
      return;
    }
    setCategoryName("");
    setCategoryDescription("");
    setCategoryNotice(`Added ${res.data.name}.`);
    refresh();
  }

  async function saveCategory() {
    if (!editingCategory) return;
    if (!editingCategory.name.trim()) {
      setCategoryError("Give the category a name.");
      return;
    }
    // PATCH, not the whole-row POST — and a sparse one. Diffing against the row
    // as loaded is what keeps a rename here from reverting a review-group
    // change another admin made while this editor sat open.
    const patch = planCategoryPatch(editingCategory, editingCategory.loaded);
    if (!patch) {
      setEditingCategory(null);
      setCategoryError(null);
      setCategoryNotice("No category details have changed.");
      return;
    }
    setCategoryBusy(editingCategory.id);
    setCategoryError(null);
    setCategoryNotice(null);
    const res = await apiPatch<CategoryView>("/api/cfp/categories", {
      id: editingCategory.id,
      ...patch,
    });
    setCategoryBusy(null);
    if (!res.ok) {
      const fields = firstFieldErrors(res.error.fieldErrors);
      setCategoryError(fields.name ?? fields.description ?? fields.defaultTeamKey ?? res.error.message);
      return;
    }
    setEditingCategory(null);
    setCategoryNotice(`Saved ${res.data.name}.`);
    refresh();
  }

  async function removeCategory(category: CategoryView) {
    if (!window.confirm(`Remove “${category.name}”? This is only available when no proposals or sessions use it.`)) return;
    setCategoryBusy(`delete:${category.id}`);
    setCategoryError(null);
    setCategoryNotice(null);
    const res = await apiDelete<CategoryView>(
      `/api/cfp/categories?categoryId=${encodeURIComponent(category.id)}`,
    );
    setCategoryBusy(null);
    if (!res.ok) {
      // Never remove the row locally: a 409 means it remains real event data.
      setCategoryError(res.error.message);
      return;
    }
    setCategoryNotice(`Removed ${res.data.name}.`);
    refresh();
  }

  return (
    <div className="settings-grid">
      <section className="card settings-card" aria-labelledby="event-details-heading">
        <div className="settings-heading">
          <div className="settings-icon"><CalendarDays size={18} aria-hidden="true" /></div>
          <div>
            <h2 id="event-details-heading">Event details</h2>
            <p>Set the name, dates, and local time zone people use when planning this event.</p>
          </div>
        </div>
        <form
          className="settings-form"
          onSubmit={(formEvent) => {
            formEvent.preventDefault();
            void saveEvent();
          }}
        >
          <label className="stack" htmlFor="event-name">
            <span className="field-label">Event name</span>
            <input
              id="event-name"
              className="text-input"
              name="event-name"
              autoComplete="organization"
              value={event.name}
              onChange={(change) => updateEvent("name", change.target.value)}
              aria-invalid={eventError?.field === "name"}
              aria-describedby={eventError?.field === "name" ? "event-settings-error" : undefined}
            />
          </label>

          <label className="stack" htmlFor="event-slug">
            <span className="field-label">Event web address</span>
            <input id="event-slug" className="text-input" value={view.event.slug} readOnly aria-describedby="event-slug-help" />
            <span className="hint" id="event-slug-help">This address is fixed once your event is created.</span>
          </label>

          <label className="stack" htmlFor="event-timezone">
            <span className="field-label">Time zone</span>
            <input
              id="event-timezone"
              className="text-input"
              name="event-timezone"
              list="event-timezone-options"
              autoComplete="off"
              value={event.timezone}
              onChange={(change) => updateEvent("timezone", change.target.value)}
              aria-invalid={eventError?.field === "timezone"}
              aria-describedby={eventError?.field === "timezone" ? "event-timezone-help event-settings-error" : "event-timezone-help"}
            />
            <datalist id="event-timezone-options">
              {COMMON_TIME_ZONES.map((timezone) => <option key={timezone} value={timezone} />)}
            </datalist>
            <span className="hint" id="event-timezone-help">Choose the suggested city nearest to your event, such as Chicago, London, or Tokyo.</span>
          </label>

          <fieldset
            className="settings-date-fields"
            aria-invalid={eventError?.field === "dates"}
            aria-describedby={eventError?.field === "dates" ? "event-dates-help event-settings-error" : "event-dates-help"}
          >
            <legend className="field-label">Event dates</legend>
            <p className="hint" id="event-dates-help">Use both dates for a multi-day event, or clear both while dates are still to be decided.</p>
            <div className="grid-2">
              <label className="stack" htmlFor="event-starts-on">
                <span className="field-label">Starts</span>
                <input
                  id="event-starts-on"
                  className="text-input"
                  type="date"
                  name="event-starts-on"
                  value={event.startsOn}
                  onChange={(change) => updateEvent("startsOn", change.target.value)}
                />
              </label>
              <label className="stack" htmlFor="event-ends-on">
                <span className="field-label">Ends</span>
                <input
                  id="event-ends-on"
                  className="text-input"
                  type="date"
                  name="event-ends-on"
                  value={event.endsOn}
                  onChange={(change) => updateEvent("endsOn", change.target.value)}
                />
              </label>
            </div>
          </fieldset>

          {eventError ? <p className="field-error" id="event-settings-error" role="alert">{eventError.message}</p> : null}
          {eventNotice ? <p className="settings-notice" role="status" aria-live="polite">{eventNotice}</p> : null}
          <button className="primary-button settings-submit" type="submit" disabled={savingEvent || pending}>
            {savingEvent ? "Saving…" : "Save event details"}
          </button>
        </form>
      </section>

      <section className="card settings-card" aria-labelledby="rooms-heading">
        <div className="settings-heading">
          <div className="settings-icon"><Building2 size={18} aria-hidden="true" /></div>
          <div>
            <h2 id="rooms-heading">Rooms</h2>
            <p>Add the places sessions can happen, and keep their names and capacities current.</p>
          </div>
        </div>

        <form
          className="settings-inline-form"
          onSubmit={(formEvent) => {
            formEvent.preventDefault();
            void addRoom();
          }}
        >
          <label className="stack" htmlFor="new-room-name">
            <span className="field-label">Room name</span>
            <input id="new-room-name" className="text-input" name="new-room-name" autoComplete="off" value={newRoomName} onChange={(change) => setNewRoomName(change.target.value)} />
          </label>
          <label className="stack" htmlFor="new-room-capacity">
            <span className="field-label">Capacity <span className="muted">(optional)</span></span>
            <input id="new-room-capacity" className="text-input" type="number" min={1} step={1} inputMode="numeric" name="new-room-capacity" value={newRoomCapacity} onChange={(change) => setNewRoomCapacity(change.target.value)} />
          </label>
          <button className="primary-button" type="submit" disabled={roomBusy !== null || pending}>
            <Plus size={16} aria-hidden="true" /> {roomBusy === "new" ? "Adding…" : "Add room"}
          </button>
        </form>
        {roomError ? <p className="field-error" role="alert">{roomError}</p> : null}
        {roomNotice ? <p className="settings-notice" role="status" aria-live="polite">{roomNotice}</p> : null}

        {view.rooms.length === 0 ? (
          <EmptyState icon={<Building2 size={22} aria-hidden="true" />} title="No rooms yet">
            Add the first room before scheduling sessions.
          </EmptyState>
        ) : (
          <div className="table-scroll settings-table-scroll">
            <table className="data-table">
              <caption className="sr-only">Rooms available for this event</caption>
              <thead>
                <tr><th scope="col">Room</th><th scope="col">Capacity</th><th scope="col"><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {view.rooms.map((room) => (
                  <RoomRow
                    key={room.id}
                    room={room}
                    draft={editingRoom?.id === room.id ? editingRoom : null}
                    busy={roomBusy === room.id || roomBusy === `delete:${room.id}`}
                    onEdit={() => {
                      setRoomError(null);
                      setEditingRoom({
                        id: room.id,
                        name: room.name,
                        capacity: room.capacity?.toString() ?? "",
                        loaded: { name: room.name, capacity: room.capacity },
                      });
                    }}
                    onCancel={() => setEditingRoom(null)}
                    onDraftChange={setEditingRoom}
                    onSave={saveRoom}
                    onRemove={() => void removeRoom(room)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card settings-card" aria-labelledby="programme-structure-heading">
        <div className="settings-heading">
          <div className="settings-icon"><Tags size={18} aria-hidden="true" /></div>
          <div>
            <h2 id="programme-structure-heading">Tracks & Categories</h2>
            <p>Keep the program groupings your team uses current: tracks are the schedule's swimlanes, categories are the topics proposals are filed and routed under.</p>
          </div>
        </div>

        <div className="settings-structure-grid">
          <section aria-labelledby="tracks-list-heading">
            <h3 id="tracks-list-heading">Tracks</h3>

            <form
              className="settings-inline-form settings-track-form"
              onSubmit={(formEvent) => {
                formEvent.preventDefault();
                void addTrack();
              }}
            >
              <label className="stack" htmlFor="new-track-name">
                <span className="field-label">Track name</span>
                <input id="new-track-name" className="text-input" name="new-track-name" autoComplete="off" value={newTrackName} onChange={(change) => setNewTrackName(change.target.value)} />
              </label>
              <label className="stack" htmlFor="new-track-colour">
                <span className="field-label">Colour</span>
                <input id="new-track-colour" className="colour-input" type="color" name="new-track-colour" value={newTrackColour} onChange={(change) => setNewTrackColour(change.target.value)} />
              </label>
              <button className="primary-button" type="submit" disabled={trackBusy !== null || pending}>
                <Plus size={16} aria-hidden="true" /> {trackBusy === "new" ? "Adding…" : "Add track"}
              </button>
            </form>
            {trackError ? <p className="field-error" role="alert">{trackError}</p> : null}
            {trackNotice ? <p className="settings-notice" role="status" aria-live="polite">{trackNotice}</p> : null}

            {view.tracks.length === 0 ? <p className="hint">No tracks yet — add one above.</p> : (
              <ul className="settings-list">
                {view.tracks.map((track) => (
                  <TrackRow
                    key={track.id}
                    track={track}
                    draft={editingTrack?.id === track.id ? editingTrack : null}
                    busy={trackBusy === track.id || trackBusy === `delete:${track.id}`}
                    onEdit={() => {
                      setTrackError(null);
                      setEditingTrack({
                        id: track.id,
                        name: track.name,
                        color: normalizeHex(track.color, DEFAULT_TRACK_COLOUR),
                        loaded: { name: track.name, color: track.color },
                      });
                    }}
                    onCancel={() => setEditingTrack(null)}
                    onDraftChange={setEditingTrack}
                    onSave={saveTrack}
                    onRemove={() => void removeTrack(track)}
                  />
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="categories-list-heading">
            <h3 id="categories-list-heading">Categories</h3>
            {view.categories.length === 0 ? <p className="hint">No categories yet — add one below.</p> : (
              <ul className="settings-list">
                {view.categories.map((category) => (
                  <CategoryRow
                    key={category.id}
                    category={category}
                    draft={editingCategory?.id === category.id ? editingCategory : null}
                    busy={categoryBusy === category.id || categoryBusy === `delete:${category.id}`}
                    onEdit={() => {
                      setCategoryError(null);
                      setEditingCategory({
                        id: category.id,
                        name: category.name,
                        description: category.description ?? "",
                        defaultTeamKey: category.defaultTeamKey ?? "",
                        loaded: {
                          name: category.name,
                          description: category.description,
                          defaultTeamKey: category.defaultTeamKey,
                        },
                      });
                    }}
                    onCancel={() => setEditingCategory(null)}
                    onDraftChange={setEditingCategory}
                    onSave={saveCategory}
                    onRemove={() => void removeCategory(category)}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>

        <form
          className="settings-category-form"
          onSubmit={(formEvent) => {
            formEvent.preventDefault();
            void addCategory();
          }}
        >
          <h3>Add a category</h3>
          <div className="grid-2">
            <label className="stack" htmlFor="new-category-name">
              <span className="field-label">Category name</span>
              <input id="new-category-name" className="text-input" name="new-category-name" autoComplete="off" value={categoryName} onChange={(change) => setCategoryName(change.target.value)} />
            </label>
            <label className="stack" htmlFor="new-category-description">
              <span className="field-label">Description <span className="muted">(optional)</span></span>
              <input id="new-category-description" className="text-input" name="new-category-description" autoComplete="off" value={categoryDescription} onChange={(change) => setCategoryDescription(change.target.value)} />
            </label>
          </div>
          {categoryError ? <p className="field-error" role="alert">{categoryError}</p> : null}
          {categoryNotice ? <p className="settings-notice" role="status" aria-live="polite">{categoryNotice}</p> : null}
          <button className="ghost-button" type="submit" disabled={categoryBusy !== null || pending}>
            <Plus size={15} aria-hidden="true" /> {categoryBusy === "new" ? "Adding…" : "Add category"}
          </button>
        </form>
      </section>
    </div>
  );
}

function RoomRow({
  room,
  draft,
  busy,
  onEdit,
  onCancel,
  onDraftChange,
  onSave,
  onRemove,
}: {
  room: EventSettingsView["rooms"][number];
  draft: RoomDraft | null;
  busy: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onDraftChange: (draft: RoomDraft) => void;
  onSave: () => Promise<void>;
  onRemove: () => void;
}) {
  if (draft) {
    return (
      <tr>
        <td colSpan={3}>
          <form
            className="settings-room-editor"
            onSubmit={(formEvent) => {
              formEvent.preventDefault();
              void onSave();
            }}
          >
            <label className="stack" htmlFor={`room-name-${room.id}`}>
              <span className="field-label">Room name</span>
              <input id={`room-name-${room.id}`} className="text-input" name={`room-name-${room.id}`} autoComplete="off" value={draft.name} onChange={(change) => onDraftChange({ ...draft, name: change.target.value })} />
            </label>
            <label className="stack" htmlFor={`room-capacity-${room.id}`}>
              <span className="field-label">Capacity <span className="muted">(optional)</span></span>
              <input id={`room-capacity-${room.id}`} className="text-input" type="number" min={1} step={1} inputMode="numeric" name={`room-capacity-${room.id}`} value={draft.capacity} onChange={(change) => onDraftChange({ ...draft, capacity: change.target.value })} />
            </label>
            <div className="row wrap settings-row-actions">
              <button className="primary-button" type="submit" disabled={busy}>{busy ? "Saving…" : "Save room"}</button>
              <button className="ghost-button" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
            </div>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td className="cell-title">{room.name}</td>
      <td>{room.capacity ? room.capacity.toLocaleString() : <span className="muted">Not set</span>}</td>
      <td>
        <div className="row wrap settings-row-actions">
          <button className="ghost-button" type="button" disabled={busy} onClick={onEdit}>Edit</button>
          <button className="ghost-button danger-button" type="button" disabled={busy} onClick={onRemove}>
            <Trash2 size={15} aria-hidden="true" /> {busy ? "Working…" : "Remove"}
          </button>
        </div>
      </td>
    </tr>
  );
}

function TrackRow({
  track,
  draft,
  busy,
  onEdit,
  onCancel,
  onDraftChange,
  onSave,
  onRemove,
}: {
  track: TrackView;
  draft: TrackDraft | null;
  busy: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onDraftChange: (draft: TrackDraft) => void;
  onSave: () => Promise<void>;
  onRemove: () => void;
}) {
  if (draft) {
    return (
      <li>
        <form
          className="settings-taxonomy-editor"
          onSubmit={(formEvent) => {
            formEvent.preventDefault();
            void onSave();
          }}
        >
          <label className="stack" htmlFor={`track-name-${track.id}`}>
            <span className="field-label">Track name</span>
            <input id={`track-name-${track.id}`} className="text-input" name={`track-name-${track.id}`} autoComplete="off" value={draft.name} onChange={(change) => onDraftChange({ ...draft, name: change.target.value })} />
          </label>
          <label className="stack" htmlFor={`track-colour-${track.id}`}>
            <span className="field-label">Colour</span>
            <input id={`track-colour-${track.id}`} className="colour-input" type="color" name={`track-colour-${track.id}`} value={draft.color} onChange={(change) => onDraftChange({ ...draft, color: change.target.value })} />
          </label>
          <div className="row wrap settings-row-actions">
            <button className="primary-button" type="submit" disabled={busy}>{busy ? "Saving…" : "Save track"}</button>
            <button className="ghost-button" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li>
      <span className="settings-track-colour" style={{ background: track.color }} aria-hidden="true" />
      <span>{track.name}</span>
      <div className="row wrap settings-row-actions">
        <button className="ghost-button" type="button" disabled={busy} onClick={onEdit}>Edit</button>
        <button className="ghost-button danger-button" type="button" disabled={busy} onClick={onRemove}>
          <Trash2 size={15} aria-hidden="true" /> {busy ? "Working…" : "Remove"}
        </button>
      </div>
    </li>
  );
}

function CategoryRow({
  category,
  draft,
  busy,
  onEdit,
  onCancel,
  onDraftChange,
  onSave,
  onRemove,
}: {
  category: CategoryView;
  draft: CategoryDraft | null;
  busy: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onDraftChange: (draft: CategoryDraft) => void;
  onSave: () => Promise<void>;
  onRemove: () => void;
}) {
  if (draft) {
    return (
      <li>
        <form
          className="settings-taxonomy-editor"
          onSubmit={(formEvent) => {
            formEvent.preventDefault();
            void onSave();
          }}
        >
          <label className="stack" htmlFor={`category-name-${category.id}`}>
            <span className="field-label">Category name</span>
            <input id={`category-name-${category.id}`} className="text-input" name={`category-name-${category.id}`} autoComplete="off" value={draft.name} onChange={(change) => onDraftChange({ ...draft, name: change.target.value })} />
          </label>
          <label className="stack" htmlFor={`category-description-${category.id}`}>
            <span className="field-label">Description <span className="muted">(optional)</span></span>
            <input id={`category-description-${category.id}`} className="text-input" name={`category-description-${category.id}`} autoComplete="off" value={draft.description} onChange={(change) => onDraftChange({ ...draft, description: change.target.value })} />
          </label>
          {/* Editable here so a rename can never be the reason a category
              silently stops routing its proposals to a review group. */}
          <label className="stack" htmlFor={`category-team-${category.id}`}>
            <span className="field-label">Review group <span className="muted">(optional)</span></span>
            <input id={`category-team-${category.id}`} className="text-input" name={`category-team-${category.id}`} autoComplete="off" value={draft.defaultTeamKey} onChange={(change) => onDraftChange({ ...draft, defaultTeamKey: change.target.value })} />
          </label>
          <div className="row wrap settings-row-actions">
            <button className="primary-button" type="submit" disabled={busy}>{busy ? "Saving…" : "Save category"}</button>
            <button className="ghost-button" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li>
      <span>
        <strong>{category.name}</strong>
        {category.description ? <span className="cell-sub">{category.description}</span> : null}
      </span>
      {category.defaultTeamKey ? <Pill tone="neutral">Review group: {category.defaultTeamKey}</Pill> : null}
      <div className="row wrap settings-row-actions">
        <button className="ghost-button" type="button" disabled={busy} onClick={onEdit}>Edit</button>
        <button className="ghost-button danger-button" type="button" disabled={busy} onClick={onRemove}>
          <Trash2 size={15} aria-hidden="true" /> {busy ? "Working…" : "Remove"}
        </button>
      </div>
    </li>
  );
}
