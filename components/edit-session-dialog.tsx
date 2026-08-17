"use client";

import { useEffect, useId, useRef, useState } from "react";
import { apiPatch, firstFieldErrors } from "@/lib/api-client";
import type { AgendaCategoryOption, AgendaSession } from "@/lib/data/reads";

/**
 * Fix a confirmed talk's own content — title, summary, format, length, topic.
 *
 * The gap this closes: the speaker owns the source proposal (INV-EDIT-001) and
 * the organizer owned only "published / unpublished", so an accepted talk with a
 * typo in its title had no editor at all. `PATCH /api/agenda/sessions` now takes
 * these five fields; who presents the talk is still not one of them — the roster
 * is locked once a `Session` exists and is administered from the Speakers page.
 *
 * A file of its own rather than a panel inside `agenda-builder.tsx`, for the
 * reason `new-session-dialog.tsx` gives: that file's GRA2-06 contract pins it at
 * exactly one `<dialog>` element, its preview and schedule editor sharing a
 * single shell, so a second literal there would mean the shell was bypassed.
 * This mirrors the sibling dialog's pattern instead — a native `<dialog>` opened
 * with `showModal()`, which is where the focus trap, Escape and inert background
 * come from, and a write in flight blocks both dismissal routes.
 *
 * Mounted only when a talk is being edited, so there is no server-rendered open
 * state to reconcile and the effect can open unconditionally.
 *
 * The server is the authority on what the programme then holds: on success this
 * hands back to the builder, which re-reads the RSC payload rather than patching
 * its local list.
 */
export function EditSessionDialog({
  session,
  categoryOptions,
  onClose,
  onSaved,
}: {
  session: AgendaSession;
  categoryOptions: AgendaCategoryOption[];
  onClose: () => void;
  /** Called with the saved title, which is the stored one, not the typed one. */
  onSaved: (savedTitle: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(session.title);
  const [description, setDescription] = useState(session.description ?? "");
  const [format, setFormat] = useState(session.format ?? "");
  const [durationMinutes, setDurationMinutes] = useState(String(session.durationMinutes));
  const [categoryId, setCategoryId] = useState(session.category?.id ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const ids = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    titleRef.current?.focus();
  }, []);

  function close() {
    // A write in flight must not be discardable by Escape or a backdrop click.
    if (saving) return;
    onClose();
  }

  async function save() {
    const trimmedTitle = title.trim();
    const minutes = Number(durationMinutes);
    const next: Record<string, string> = {};
    if (trimmedTitle.length < 3) next.title = "Give the talk a title of at least 3 characters.";
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 480) {
      next.durationMinutes = "Use a whole number of minutes between 5 and 480.";
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setSaving(true);
    // Every field is sent, including the ones that did not change: this form
    // shows the talk's whole content, so what it holds IS the intended state.
    // Cleared text is sent as null, which is how the contract spells "no value"
    // — an empty string would store a blank summary instead of removing it.
    const res = await apiPatch<{ id: string; title: string }>("/api/agenda/sessions", {
      sessionId: session.id,
      title: trimmedTitle,
      description: description.trim() || null,
      format: format.trim() || null,
      durationMinutes: minutes,
      categoryId: categoryId || null,
    });
    setSaving(false);

    if (!res.ok) {
      const mapped = firstFieldErrors(res.error.fieldErrors);
      setErrors(Object.keys(mapped).length > 0 ? mapped : { _root: res.error.message });
      return;
    }

    onSaved(res.data.title);
  }

  const durationChanged = Number(durationMinutes) !== session.durationMinutes;

  return (
    <dialog
      ref={dialogRef}
      className="card agenda-dialog agenda-schedule-dialog"
      aria-labelledby={`${ids}-eyebrow ${ids}-title`}
      onClose={close}
      onCancel={(event) => {
        if (saving) event.preventDefault();
      }}
      onMouseDown={(event) => {
        if (event.target === dialogRef.current && !saving) close();
      }}
    >
      <div className="agenda-dialog-body">
        <form
          method="dialog"
          onSubmit={(event) => {
            event.preventDefault();
            save().catch((error) => {
              console.warn("Session edit failed", error);
              setSaving(false);
              setErrors({ _root: "Could not save the session. Check your connection and try again." });
            });
          }}
        >
          <p className="eyebrow" id={`${ids}-eyebrow`}>Edit session</p>
          <h2 id={`${ids}-title`} style={{ margin: "0 0 4px" }}>{session.title}</h2>
          <p className="hint">
            {session.speakers.map((speaker) => speaker.name).join(", ") || "No speakers"}
          </p>
          <p className="hint">
            This changes the talk as the program shows it. Who presents it is set on the Speakers
            page, and the proposal the speaker submitted is left untouched.
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
              onChange={(event) => setTitle(event.target.value)}
            />
            {errors.title ? <span className="field-error">{errors.title}</span> : null}
          </label>

          <label className="stack" style={{ marginTop: 14 }} htmlFor={`${ids}-description`}>
            <span className="field-label">Summary <span className="muted">(optional)</span></span>
            <textarea
              id={`${ids}-description`}
              className="text-input"
              rows={4}
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

          <label className="stack" style={{ marginTop: 14 }} htmlFor={`${ids}-category`}>
            <span className="field-label">Topic <span className="muted">(optional)</span></span>
            <select
              id={`${ids}-category`}
              className="select-input"
              value={categoryId}
              aria-invalid={!!errors.categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
            >
              <option value="">No topic</option>
              {categoryOptions.map((option) => (
                <option key={option.id} value={option.id}>{option.name}</option>
              ))}
            </select>
            {/* The topic is the taxonomy the proposal was submitted under, not
                the schedule swimlane: the track is chosen when the talk is
                placed, and this form deliberately cannot change it. */}
            <span className="hint">
              {categoryOptions.length > 0
                ? "The program's own topic label. Tracks are set when you place the talk."
                : "This event has no topics yet. Add them in event settings to label the program."}
            </span>
            {errors.categoryId ? <span className="field-error">{errors.categoryId}</span> : null}
          </label>

          {/* Stated rather than silently true: the slot keeps the interval it was
              placed with, because re-deriving it here would be a placement made
              without a conflict check (INV-SCHEDULE-001). */}
          {session.slot && durationChanged ? (
            <p className="hint" role="status" style={{ marginTop: 14 }}>
              This talk is already on the schedule. Changing its length here does not move or
              resize the block — open “Move session” to re-place it, where room and speaker
              conflicts are re-checked.
            </p>
          ) : null}

          <div className="row wrap" style={{ justifyContent: "flex-end", marginTop: 22 }}>
            <button className="ghost-button" type="button" onClick={close} disabled={saving}>
              Cancel
            </button>
            <button className="primary-button" type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
