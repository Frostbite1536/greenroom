"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { apiPost, firstFieldErrors } from "@/lib/api-client";

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

/**
 * Starter questions so a brand-new form is immediately demonstrable in the
 * builder and the public renderer. Title, summary and speakers are core fields
 * rendered by `CfpForm` itself; these are the configurable extras.
 */
const STARTER_FIELDS = [
  {
    key: "audience_level",
    label: "Audience level",
    type: "SELECT" as const,
    required: true,
    sortOrder: 0,
    options: [
      { label: "Beginner", value: "beginner" },
      { label: "Intermediate", value: "intermediate" },
      { label: "Advanced", value: "advanced" },
    ],
  },
  {
    key: "learning_objectives",
    label: "What will attendees learn?",
    helpText: "Three concrete takeaways.",
    type: "LONG_TEXT" as const,
    required: true,
    sortOrder: 1,
  },
];

export function NewFormDialog({
  eventId,
  eventSlug,
  existingSlugs,
}: {
  eventId: string;
  eventSlug: string;
  /** Checked client-side: the API surfaces a duplicate `(eventId, slug)` as a generic 500. */
  existingSlugs: string[];
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
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
    setErrors({});
    setSubmitting(false);
  }

  function close() {
    setOpen(false);
    reset();
  }

  async function create() {
    const trimmed = name.trim();
    const next: Record<string, string> = {};
    if (!trimmed) next.name = "Give the form a name.";
    if (!effectiveSlug) next.slug = "A public URL slug is required.";
    else if (!SLUG_RE.test(effectiveSlug)) next.slug = "Lowercase letters, numbers and single dashes only.";
    else if (existingSlugs.includes(effectiveSlug)) next.slug = "Another form already uses this slug.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setSubmitting(true);
    const res = await apiPost<{ id: string }>("/api/cfp/forms", {
      eventId,
      name: trimmed,
      slug: effectiveSlug,
      welcomeText: `Submit your proposal for ${trimmed}.`,
      thankYouText: "Thanks for your submission! The program team will follow up by email.",
      minSpeakers: 1,
      maxSpeakers: 2,
      maxBioLength: 1000,
      published: false,
      fields: STARTER_FIELDS,
    });

    if (!res.ok) {
      setSubmitting(false);
      const mapped = firstFieldErrors(res.error.fieldErrors);
      setErrors(
        Object.keys(mapped).length > 0
          ? mapped
          : {
              _root:
                res.error.code === "INTERNAL_ERROR"
                  ? "Could not create the form. The URL slug may already be in use."
                  : res.error.message,
            },
      );
      return;
    }

    // The builder is the only place that can finish configuring a form, and it
    // surfaces the canonical event-scoped public link and the publish toggle.
    router.push(`/admin/forms/${res.data.id}`);
  }

  return (
    <>
      <button
        className="primary-button"
        type="button"
        onClick={() => setOpen(true)}
        style={{ display: "inline-flex", alignItems: "center", gap: 7 }}
      >
        <Plus size={16} aria-hidden="true" /> New form
      </button>

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
              console.warn("Form creation failed", error);
              setSubmitting(false);
              setErrors({ _root: "Could not create the form. Check your connection and try again." });
            });
          }}
        >
          <h2 id={`${ids}-title`}>New submission form</h2>
          <p className="hint">
            Creates an unpublished form with two starter questions. You can edit everything,
            set the window and publish it in the builder.
          </p>

          {errors._root ? (
            <p className="conflict-banner" role="alert" style={{ marginTop: 14 }}>{errors._root}</p>
          ) : null}

          <label className="stack" style={{ marginTop: 16 }}>
            <span className="field-label">Form name</span>
            <input
              ref={nameRef}
              className="text-input"
              value={name}
              maxLength={160}
              aria-invalid={!!errors.name}
              placeholder="2027 Call for Speakers"
              onChange={(event) => setName(event.target.value)}
            />
            {errors.name ? <span className="field-error">{errors.name}</span> : null}
          </label>

          <label className="stack" style={{ marginTop: 14 }}>
            <span className="field-label">Public URL slug</span>
            <input
              className="text-input"
              value={effectiveSlug}
              aria-invalid={!!errors.slug}
              aria-describedby={`${ids}-slug-hint`}
              onChange={(event) => {
                setSlugTouched(true);
                setSlug(event.target.value);
              }}
            />
            <span className="hint" id={`${ids}-slug-hint`}>
              /cfp/{eventSlug}/{effectiveSlug || "your-form"}
            </span>
            {errors.slug ? <span className="field-error">{errors.slug}</span> : null}
          </label>

          <div className="row wrap" style={{ justifyContent: "flex-end", marginTop: 22 }}>
            <button className="ghost-button" type="button" onClick={close} disabled={submitting}>
              Cancel
            </button>
            <button className="primary-button" type="submit" disabled={submitting}>
              {submitting ? "Creating…" : "Create form"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
