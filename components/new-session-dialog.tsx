"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus } from "lucide-react";
import { apiPost, firstFieldErrors } from "@/lib/api-client";
import type { AgendaSpeakerOption } from "@/lib/data/reads";
import { guaranteedSessionConfirmation } from "@/lib/guaranteed-session-confirmation";

/**
 * Author one talk directly on the programme — a keynote, a sponsor slot — from
 * the surface the programme already lives on.
 *
 * A separate component rather than a panel inside `AgendaBuilder` for two
 * reasons. It joins the three admin dialogs (`new-event-dialog`,
 * `new-form-dialog`, the roster's) that are already native `<dialog>` elements
 * driven from a `PageHeader` action, so there is one pattern here and not two.
 * And the builder's own GRA2-06 contract pins it at exactly one `<dialog>`
 * element — its preview and schedule editor share a single shell — so a second
 * literal in that file would mean the shell had been bypassed.
 *
 * Speakers are picked from this event's roster, never typed. The server accepts
 * user ids and refuses anything not on the roster (404), because minting a
 * global `User` account is `POST /api/admin/speakers`' job under its own
 * identity locks — see `guaranteedSessionInputSchema`. The picker is therefore
 * the roster, and adding somebody new is a trip to the speaker page first.
 *
 * Success does not navigate. It names what was created, the same accounting
 * `lib/decision-confirmation.ts` gives acceptance, and refreshes the RSC payload
 * so the new draft appears in the builder's unscheduled backlog where the next
 * step — placing it — actually happens.
 */

/** What `POST /api/agenda/sessions` returns. */
type CreatedSession = {
  id: string;
  title: string;
  durationMinutes: number;
  speakersAdded: number;
  tasksAssigned: number;
};

/** The house default a talk starts at, matching `DEFAULT_SESSION_MINUTES`. */
const DEFAULT_MINUTES = "30";

export function NewSessionDialog({
  eventId,
  speakerOptions,
}: {
  eventId: string;
  speakerOptions: AgendaSpeakerOption[];
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [format, setFormat] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(DEFAULT_MINUTES);
  const [speakerIds, setSpeakerIds] = useState<string[]>([]);
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreatedSession | null>(null);
  const ids = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      // showModal() gives us the focus trap, Esc handling and inert background
      // for free — no hand-rolled trap needed here.
      dialog.showModal();
      titleRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  function reset() {
    setTitle("");
    setDescription("");
    setFormat("");
    setDurationMinutes(DEFAULT_MINUTES);
    setSpeakerIds([]);
    setPrimaryId(null);
    setErrors({});
    setSubmitting(false);
  }

  function close() {
    // A write in flight must not be discardable by Escape or a backdrop click.
    if (submitting) return;
    setOpen(false);
    reset();
  }

  /** Deselecting the primary speaker must not leave a primary nobody is. */
  function toggleSpeaker(userId: string) {
    setSpeakerIds((current) => {
      if (current.includes(userId)) {
        setPrimaryId((primary) => (primary === userId ? null : primary));
        return current.filter((id) => id !== userId);
      }
      // First one picked leads by default; the organizer can move it.
      setPrimaryId((primary) => primary ?? userId);
      return [...current, userId];
    });
  }

  async function create() {
    const trimmedTitle = title.trim();
    const minutes = Number(durationMinutes);
    const next: Record<string, string> = {};
    if (trimmedTitle.length < 3) next.title = "Give the talk a title of at least 3 characters.";
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 480) {
      next.durationMinutes = "Use a whole number of minutes between 5 and 480.";
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setSubmitting(true);
    const res = await apiPost<CreatedSession>("/api/agenda/sessions", {
      eventId,
      title: trimmedTitle,
      // Omitted rather than sent blank: the contract's optional fields mean
      // "not stated", and an empty string is a stated empty value.
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(format.trim() ? { format: format.trim() } : {}),
      durationMinutes: minutes,
      speakers: speakerIds.map((userId) => ({ userId, isPrimary: userId === primaryId })),
    });
    setSubmitting(false);

    if (!res.ok) {
      const mapped = firstFieldErrors(res.error.fieldErrors);
      setErrors(Object.keys(mapped).length > 0 ? mapped : { _root: res.error.message });
      return;
    }

    setCreated(res.data);
    setOpen(false);
    reset();
    // The server is the authority on what the programme now holds, so the
    // backlog is re-read rather than patched from this response.
    router.refresh();
  }

  return (
    <>
      <button
        className="primary-button"
        type="button"
        onClick={() => {
          setCreated(null);
          setOpen(true);
        }}
        style={{ display: "inline-flex", alignItems: "center", gap: 7 }}
      >
        <CalendarPlus size={16} aria-hidden="true" /> Add session
      </button>

      {created ? (
        <p className="settings-notice" role="status" aria-live="polite">
          {guaranteedSessionConfirmation(created)}
        </p>
      ) : null}

      <dialog
        ref={dialogRef}
        className="app-dialog speaker-dialog"
        aria-labelledby={`${ids}-title`}
        onClose={close}
        onCancel={(event) => {
          if (submitting) event.preventDefault();
          close();
        }}
        onMouseDown={(event) => {
          if (event.target === dialogRef.current) close();
        }}
      >
        <form
          method="dialog"
          onSubmit={(event) => {
            event.preventDefault();
            create().catch((error) => {
              console.warn("Session creation failed", error);
              setSubmitting(false);
              setErrors({ _root: "Could not create the session. Check your connection and try again." });
            });
          }}
        >
          <h2 id={`${ids}-title`}>Add session</h2>
          <p className="hint">
            For a talk with no proposal behind it — a keynote, an opening address, a sponsor
            slot. It is created as a draft, so it stays off the public program until you
            publish it, and it starts unscheduled.
          </p>

          {errors._root ? (
            <p className="conflict-banner" role="alert" style={{ marginTop: 14 }}>{errors._root}</p>
          ) : null}

          <label className="stack" style={{ marginTop: 16 }} htmlFor={`${ids}-session-title`}>
            <span className="field-label">Title</span>
            <input
              ref={titleRef}
              id={`${ids}-session-title`}
              className="text-input"
              value={title}
              maxLength={180}
              aria-invalid={!!errors.title}
              placeholder="Opening keynote"
              onChange={(event) => setTitle(event.target.value)}
            />
            {errors.title ? <span className="field-error">{errors.title}</span> : null}
          </label>

          <label className="stack" style={{ marginTop: 14 }} htmlFor={`${ids}-description`}>
            <span className="field-label">Summary <span className="muted">(optional)</span></span>
            <textarea
              id={`${ids}-description`}
              className="text-input"
              rows={3}
              value={description}
              maxLength={5000}
              aria-invalid={!!errors.description}
              placeholder="What attendees will see on the public program."
              onChange={(event) => setDescription(event.target.value)}
            />
            {errors.description ? <span className="field-error">{errors.description}</span> : null}
          </label>

          <div className="grid-2" style={{ marginTop: 14 }}>
            <label className="stack" htmlFor={`${ids}-format`}>
              <span className="field-label">Format <span className="muted">(optional)</span></span>
              <input
                id={`${ids}-format`}
                className="text-input"
                value={format}
                maxLength={80}
                aria-invalid={!!errors.format}
                placeholder="Keynote"
                onChange={(event) => setFormat(event.target.value)}
              />
              {errors.format ? <span className="field-error">{errors.format}</span> : null}
            </label>
            <label className="stack" htmlFor={`${ids}-duration`}>
              <span className="field-label">Length (minutes)</span>
              <input
                id={`${ids}-duration`}
                className="text-input"
                type="number"
                min={5}
                max={480}
                step={5}
                value={durationMinutes}
                aria-invalid={!!errors.durationMinutes}
                onChange={(event) => setDurationMinutes(event.target.value)}
              />
              {errors.durationMinutes ? (
                <span className="field-error">{errors.durationMinutes}</span>
              ) : null}
            </label>
          </div>

          <fieldset style={{ marginTop: 14 }} aria-describedby={`${ids}-speakers-hint`}>
            <legend className="field-label">Speakers <span className="muted">(optional)</span></legend>
            <p className="hint" id={`${ids}-speakers-hint`}>
              {speakerOptions.length > 0
                ? "From this event's roster. To add someone new, create them on the Speakers page first."
                : "This event has no speakers on its roster yet. Add them on the Speakers page, then name them here."}
            </p>
            {speakerOptions.length > 0 ? (
              /* The reviewer picker's markup and CSS, unchanged: a row that
                 holds a checkbox label plus a sibling control is exactly the
                 shape this needs, and nesting the primary radio inside the
                 checkbox's own <label> would be invalid HTML. */
              <div className="pick-list" style={{ marginTop: 8 }}>
                {speakerOptions.map((option) => {
                  const selected = speakerIds.includes(option.userId);
                  return (
                    <div className="reviewer-pick-row" key={option.userId}>
                      <label className="reviewer-pick-label">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleSpeaker(option.userId)}
                        />
                        <span>
                          <span className="cell-title">{option.name}</span>
                          <span className="cell-sub muted">{option.email}</span>
                        </span>
                      </label>
                      {selected ? (
                        <label className="reviewer-pick-label hint">
                          <input
                            type="radio"
                            name={`${ids}-primary`}
                            checked={primaryId === option.userId}
                            onChange={() => setPrimaryId(option.userId)}
                          />
                          <span>Primary speaker</span>
                        </label>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
            {errors.speakers ? <span className="field-error">{errors.speakers}</span> : null}
          </fieldset>

          <div className="row wrap" style={{ justifyContent: "flex-end", marginTop: 22 }}>
            <button className="ghost-button" type="button" onClick={close} disabled={submitting}>
              Cancel
            </button>
            <button className="primary-button" type="submit" disabled={submitting}>
              {submitting ? "Creating…" : "Create session"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
