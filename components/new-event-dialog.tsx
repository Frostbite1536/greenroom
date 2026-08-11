"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CalendarPlus } from "lucide-react";
import { apiPost, firstFieldErrors } from "@/lib/api-client";
import { COMMON_TIME_ZONES, validateEventDatePair } from "@/lib/event-settings-form";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    // The slice can cut mid-word and leave a trailing dash, which the slug
    // pattern rejects; strip again so a long name still yields a valid slug.
    .replace(/^-+|-+$/g, "");
}

type CreatedEvent = { id: string; name: string; slug: string };

/**
 * Create one empty event (D-C5-9), from the surface where event identity
 * already lives.
 *
 * Success deliberately does not navigate on its own — it OFFERS the switch
 * (D-C5-16 item 1). The workspace resolves its event from the signed session
 * cookie (`lib/auth.ts` → `session.event.id`), so moving there means re-issuing
 * that cookie, which only the server may do. The offer is therefore a plain
 * form post to the same `/api/auth/switch-event` endpoint the sidebar switcher
 * uses — not a client-side navigation, which would strand the organizer on a
 * screen still scoped to the old event. The route re-checks the membership the
 * create transaction just wrote before it moves anyone.
 */
/**
 * `onboarding` is the `/welcome` variant (D-C5-16 item 2): the same dialog and
 * the same endpoint, driven by someone who has no event yet.
 *
 * The two differences are both consequences of that. There is no current event
 * to say "nothing is copied from", and — unlike the workspace case — success
 * really does change which workspace this person is in, because the server
 * issues them a real session as ADMIN of the event it just created. So this
 * variant navigates, and the "we did not switch you" notice would be a lie here.
 */
export function NewEventDialog({
  currentEventName,
  onboarding = false,
}: {
  currentEventName?: string;
  onboarding?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [timezone, setTimezone] = useState("UTC");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreatedEvent | null>(null);
  const ids = useId();

  const effectiveSlug = slugTouched ? slug : slugify(name);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      // showModal() gives us the focus trap, Esc handling and inert background
      // for free — no hand-rolled trap needed here.
      dialog.showModal();
      nameRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  function reset() {
    setName("");
    setSlug("");
    setSlugTouched(false);
    setTimezone("UTC");
    setStartsOn("");
    setEndsOn("");
    setErrors({});
    setSubmitting(false);
  }

  function close() {
    setOpen(false);
    reset();
  }

  async function create() {
    const trimmedName = name.trim();
    const next: Record<string, string> = {};
    if (!trimmedName) next.name = "Give the event a name.";
    if (!effectiveSlug) next.slug = "A web address is required.";
    else if (!SLUG_RE.test(effectiveSlug)) next.slug = "Use lowercase letters, numbers and single dashes.";
    if (!timezone.trim()) next.timezone = "Choose a time zone.";
    // The same paired-date rule the event settings form applies, from the same
    // module. The server stays authoritative.
    const dateError = validateEventDatePair(startsOn, endsOn);
    if (dateError) next.startsOn = dateError;
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setSubmitting(true);
    const res = await apiPost<{ event: CreatedEvent }>("/api/admin/events", {
      name: trimmedName,
      slug: effectiveSlug,
      timezone: timezone.trim(),
      ...(startsOn && endsOn ? { startsOn, endsOn } : {}),
    });
    setSubmitting(false);

    if (!res.ok) {
      const mapped = firstFieldErrors(res.error.fieldErrors);
      setErrors(Object.keys(mapped).length > 0 ? mapped : { _root: res.error.message });
      return;
    }

    if (onboarding) {
      // A full navigation, not a router push: the response just replaced this
      // person's pending cookie with a real session, and only a fresh document
      // request re-reads it everywhere the shell needs it.
      window.location.assign("/admin");
      return;
    }

    setCreated(res.data.event);
    close();
  }

  return (
    <>
      <button
        className="ghost-button"
        type="button"
        onClick={() => {
          setCreated(null);
          setOpen(true);
        }}
        style={{ display: "inline-flex", alignItems: "center", gap: 7 }}
      >
        <CalendarPlus size={16} aria-hidden="true" /> {onboarding ? "Create your first event" : "New event"}
      </button>

      {/* A div, not a <p>: a form is flow content and a paragraph may not
          contain one — the browser would silently close the paragraph early. */}
      {created ? (
        <div className="settings-notice" role="status" aria-live="polite">
          Created “{created.name}” at /{created.slug}. It starts empty, and this workspace is still
          showing {currentEventName}.{" "}
          {/* The created event's id, posted to the shared switch endpoint. The
              creator holds ADMIN membership on it from the create transaction,
              which is exactly what that endpoint re-verifies. */}
          <form action="/api/auth/switch-event" className="event-switch-inline" method="post">
            <input name="eventId" type="hidden" value={created.id} />
            <button className="link-button" type="submit">
              Switch to {created.name}
            </button>
          </form>
        </div>
      ) : null}

      <dialog
        ref={dialogRef}
        className="app-dialog"
        aria-labelledby={`${ids}-title`}
        onClose={close}
        onCancel={close}
        onMouseDown={(event) => {
          if (event.target === dialogRef.current) close();
        }}
      >
        <form
          method="dialog"
          onSubmit={(event) => {
            event.preventDefault();
            create().catch((error) => {
              console.warn("Event creation failed", error);
              setSubmitting(false);
              setErrors({ _root: "Could not create the event. Check your connection and try again." });
            });
          }}
        >
          <h2 id={`${ids}-title`}>{onboarding ? "Create your first event" : "New event"}</h2>
          <p className="hint">
            {onboarding ? (
              <>
                Creates an empty event with its own rooms, forms and program, and makes you its
                organizer. The web address is fixed once the event is created.
              </>
            ) : (
              <>
                Creates an empty event with its own rooms, forms and program. Nothing is copied
                from {currentEventName}, and the web address is fixed once the event is created.
              </>
            )}
          </p>

          {errors._root ? (
            <p className="conflict-banner" role="alert" style={{ marginTop: 14 }}>{errors._root}</p>
          ) : null}

          <label className="stack" style={{ marginTop: 16 }} htmlFor={`${ids}-name`}>
            <span className="field-label">Event name</span>
            <input
              ref={nameRef}
              id={`${ids}-name`}
              className="text-input"
              value={name}
              maxLength={160}
              aria-invalid={!!errors.name}
              placeholder="Forward 2027"
              onChange={(event) => setName(event.target.value)}
            />
            {errors.name ? <span className="field-error">{errors.name}</span> : null}
          </label>

          <label className="stack" style={{ marginTop: 14 }} htmlFor={`${ids}-slug`}>
            <span className="field-label">Web address</span>
            <input
              id={`${ids}-slug`}
              className="text-input"
              value={effectiveSlug}
              maxLength={60}
              aria-invalid={!!errors.slug}
              aria-describedby={`${ids}-slug-hint`}
              onChange={(event) => {
                setSlugTouched(true);
                setSlug(event.target.value);
              }}
            />
            <span className="hint" id={`${ids}-slug-hint`}>/cfp/{effectiveSlug || "your-event"}</span>
            {errors.slug ? <span className="field-error">{errors.slug}</span> : null}
          </label>

          <label className="stack" style={{ marginTop: 14 }} htmlFor={`${ids}-timezone`}>
            <span className="field-label">Time zone</span>
            <input
              id={`${ids}-timezone`}
              className="text-input"
              list={`${ids}-timezone-options`}
              autoComplete="off"
              value={timezone}
              aria-invalid={!!errors.timezone}
              onChange={(event) => setTimezone(event.target.value)}
            />
            <datalist id={`${ids}-timezone-options`}>
              {COMMON_TIME_ZONES.map((zone) => <option key={zone} value={zone} />)}
            </datalist>
            {errors.timezone ? <span className="field-error">{errors.timezone}</span> : null}
          </label>

          <fieldset
            className="settings-date-fields"
            style={{ marginTop: 14 }}
            aria-describedby={`${ids}-dates-hint`}
            aria-invalid={!!errors.startsOn || !!errors.endsOn}
          >
            <legend className="field-label">Event dates <span className="muted">(optional)</span></legend>
            <p className="hint" id={`${ids}-dates-hint`}>
              Use both dates, or leave both empty while dates are still to be decided.
            </p>
            <div className="grid-2">
              <label className="stack" htmlFor={`${ids}-starts-on`}>
                <span className="field-label">Starts</span>
                <input
                  id={`${ids}-starts-on`}
                  className="text-input"
                  type="date"
                  value={startsOn}
                  onChange={(event) => setStartsOn(event.target.value)}
                />
              </label>
              <label className="stack" htmlFor={`${ids}-ends-on`}>
                <span className="field-label">Ends</span>
                <input
                  id={`${ids}-ends-on`}
                  className="text-input"
                  type="date"
                  value={endsOn}
                  onChange={(event) => setEndsOn(event.target.value)}
                />
              </label>
            </div>
            {errors.startsOn ? <span className="field-error">{errors.startsOn}</span> : null}
            {errors.endsOn ? <span className="field-error">{errors.endsOn}</span> : null}
          </fieldset>

          <div className="row wrap" style={{ justifyContent: "flex-end", marginTop: 22 }}>
            <button className="ghost-button" type="button" onClick={close} disabled={submitting}>
              Cancel
            </button>
            <button className="primary-button" type="submit" disabled={submitting}>
              {submitting ? "Creating…" : "Create event"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
