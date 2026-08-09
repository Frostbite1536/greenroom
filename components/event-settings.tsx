"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Building2, CalendarDays, Plus, Tags, Trash2 } from "lucide-react";
import type { EventSettingsView } from "@/lib/data/reads";
import { apiDelete, apiPatch, apiPost, firstFieldErrors } from "@/lib/api-client";
import { validateEventDatePair } from "@/lib/event-settings-form";
import { EmptyState, Pill } from "@/components/ui";

type EventForm = {
  name: string;
  timezone: string;
  startsOn: string;
  endsOn: string;
};

type RoomDraft = { id: string; name: string; capacity: string };
type EventError = { message: string; field: "name" | "timezone" | "dates" | "general" };

const COMMON_TIME_ZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Toronto",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
];

function eventForm(event: EventSettingsView["event"]): EventForm {
  return {
    name: event.name,
    timezone: event.timezone,
    startsOn: event.startsOn ?? "",
    endsOn: event.endsOn ?? "",
  };
}

function positiveCapacity(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function EventSettings({ view }: { view: EventSettingsView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [event, setEvent] = useState(() => eventForm(view.event));
  const [eventError, setEventError] = useState<EventError | null>(null);
  const [eventNotice, setEventNotice] = useState<string | null>(null);
  const [savingEvent, setSavingEvent] = useState(false);
  const [newRoomName, setNewRoomName] = useState("");
  const [newRoomCapacity, setNewRoomCapacity] = useState("");
  const [roomError, setRoomError] = useState<string | null>(null);
  const [roomNotice, setRoomNotice] = useState<string | null>(null);
  const [roomBusy, setRoomBusy] = useState<string | null>(null);
  const [editingRoom, setEditingRoom] = useState<RoomDraft | null>(null);
  const [categoryName, setCategoryName] = useState("");
  const [categoryDescription, setCategoryDescription] = useState("");
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [categoryNotice, setCategoryNotice] = useState<string | null>(null);
  const [savingCategory, setSavingCategory] = useState(false);

  // A successful mutation refreshes the RSC payload. Reset drafts only when
  // that authoritative event projection changes, never on every render.
  useEffect(() => setEvent(eventForm(view.event)), [view.event]);

  function refresh() {
    startTransition(() => router.refresh());
  }

  async function saveEvent() {
    const dateError = validateEventDatePair(event.startsOn, event.endsOn);
    if (dateError) {
      setEventError({ message: dateError, field: "dates" });
      return;
    }
    setSavingEvent(true);
    setEventError(null);
    setEventNotice(null);
    const res = await apiPatch<{ event: EventSettingsView["event"] }>("/api/admin/settings", {
      name: event.name,
      timezone: event.timezone,
      startsOn: event.startsOn || null,
      endsOn: event.endsOn || null,
    });
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
    setRoomBusy(editingRoom.id);
    setRoomError(null);
    setRoomNotice(null);
    const res = await apiPatch<{ room: EventSettingsView["rooms"][number] }>("/api/admin/settings/rooms", {
      id: editingRoom.id,
      name: editingRoom.name.trim(),
      capacity: capacity ?? null,
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

  async function addCategory() {
    if (!categoryName.trim()) {
      setCategoryError("Give the category a name.");
      return;
    }
    setSavingCategory(true);
    setCategoryError(null);
    setCategoryNotice(null);
    const res = await apiPost<{ id: string; name: string }>("/api/cfp/categories", {
      eventId: view.event.id,
      name: categoryName.trim(),
      ...(categoryDescription.trim() ? { description: categoryDescription.trim() } : {}),
      sortOrder: 0,
    });
    setSavingCategory(false);
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
              onChange={(change) => setEvent((current) => ({ ...current, name: change.target.value }))}
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
              onChange={(change) => setEvent((current) => ({ ...current, timezone: change.target.value }))}
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
                  onChange={(change) => setEvent((current) => ({ ...current, startsOn: change.target.value }))}
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
                  onChange={(change) => setEvent((current) => ({ ...current, endsOn: change.target.value }))}
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
                      setEditingRoom({ id: room.id, name: room.name, capacity: room.capacity?.toString() ?? "" });
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
            <p>These existing programme groupings are shown here for reference while you set up reviews and scheduling.</p>
          </div>
        </div>

        <div className="settings-structure-grid">
          <section aria-labelledby="tracks-list-heading">
            <h3 id="tracks-list-heading">Tracks</h3>
            {view.tracks.length === 0 ? <p className="hint">No tracks yet.</p> : (
              <ul className="settings-list">
                {view.tracks.map((track) => (
                  <li key={track.id}>
                    <span className="settings-track-colour" style={{ background: track.color }} aria-hidden="true" />
                    <span>{track.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="categories-list-heading">
            <h3 id="categories-list-heading">Categories</h3>
            {view.categories.length === 0 ? <p className="hint">No categories yet — add one below.</p> : (
              <ul className="settings-list">
                {view.categories.map((category) => (
                  <li key={category.id}>
                    <span>
                      <strong>{category.name}</strong>
                      {category.description ? <span className="cell-sub">{category.description}</span> : null}
                    </span>
                    {category.defaultTeamKey ? <Pill tone="neutral">Review group: {category.defaultTeamKey}</Pill> : null}
                  </li>
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
          <button className="ghost-button" type="submit" disabled={savingCategory || pending}>
            <Plus size={15} aria-hidden="true" /> {savingCategory ? "Adding…" : "Add category"}
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
