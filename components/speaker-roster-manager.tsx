"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, UserPlus } from "lucide-react";
import { apiPatch, apiPost, firstFieldErrors } from "@/lib/api-client";
import { speakerDialogRecovery, speakerProvisionNotice } from "@/lib/speakers/roster";
import {
  SPEAKER_CONFIRMATION_LABELS,
  type SpeakerConfirmation,
} from "@/lib/speakers/status";

/**
 * Add and edit speakers from the roster (SPK-02).
 *
 * The server is the only authority: both dialogs post to `/api/admin/speakers`
 * and then refresh the RSC payload rather than patching a local list, so what
 * the operator sees afterwards is what was actually stored. Nothing here
 * decides who may write — the route re-reads the caller's ADMIN membership under
 * its own lock.
 *
 * Blank means clear, everywhere. The edit dialog sends every field it renders,
 * including as `null`, because the API reads an omitted field as "leave it
 * alone" (C13) — emptying a bio has to be a real instruction, not an omission.
 */
export type SpeakerProfileDraft = {
  jobTitle: string;
  company: string;
  bio: string;
  headshotUrl: string;
  status: SpeakerConfirmation;
};

export type EditableSpeaker = {
  userId: string;
  name: string;
  email: string;
  jobTitle: string | null;
  company: string | null;
  bio: string | null;
  headshotUrl: string | null;
  status: SpeakerConfirmation;
};

/** New speakers start INVITED: an organizer adding somebody has not heard back
 *  from them yet, and claiming otherwise would put an unearned "Confirmed" on
 *  the roster. The stored column defaults to CONFIRMED for the opposite reason
 *  — existing rows describe people who are already taking part. */
const EMPTY_DRAFT: SpeakerProfileDraft = {
  jobTitle: "", company: "", bio: "", headshotUrl: "", status: "INVITED",
};

function draftFromSpeaker(speaker: EditableSpeaker): SpeakerProfileDraft {
  return {
    jobTitle: speaker.jobTitle ?? "",
    company: speaker.company ?? "",
    bio: speaker.bio ?? "",
    headshotUrl: speaker.headshotUrl ?? "",
    status: speaker.status,
  };
}

/** Trim, then blank-to-null: the same normalization the server re-applies. */
function nullable(value: string): string | null {
  return value.trim() === "" ? null : value.trim();
}

function profilePayload(draft: SpeakerProfileDraft) {
  return {
    jobTitle: nullable(draft.jobTitle),
    company: nullable(draft.company),
    bio: nullable(draft.bio),
    headshotUrl: nullable(draft.headshotUrl),
    // Always sent, never null: the column has a stored default and there is no
    // such thing as clearing where somebody is in accepting an invitation.
    status: draft.status,
  };
}

type SpeakerResponse = {
  speaker: { userId: string; name: string; email: string };
  requestedName: string;
  userCreated: boolean;
  membershipCreated: boolean;
  profileRequested: boolean;
  profileApplied: boolean;
};

export function AddSpeakerDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [draft, setDraft] = useState<SpeakerProfileDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function close() {
    setOpen(false);
    setName("");
    setEmail("");
    setDraft(EMPTY_DRAFT);
    setErrors({});
    setSubmitting(false);
  }

  async function submit() {
    const next: Record<string, string> = {};
    if (name.trim() === "") next.name = "Give the speaker a name.";
    if (email.trim() === "") next.email = "An email address identifies the speaker's account.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setSubmitting(true);
    setNotice(null);
    const res = await apiPost<SpeakerResponse>("/api/admin/speakers", {
      name: name.trim(),
      email: email.trim(),
      ...profilePayload(draft),
    });
    setSubmitting(false);
    if (!res.ok) {
      const mapped = firstFieldErrors(res.error.fieldErrors);
      setErrors(Object.keys(mapped).length > 0 ? mapped : { _root: res.error.message });
      return;
    }
    // Reported from the stored row, not the typed draft: when the email already
    // had an account, the saved name is what the roster will show.
    setNotice(speakerProvisionNotice({
      name: res.data.speaker.name,
      email: res.data.speaker.email,
      requestedName: res.data.requestedName,
      userCreated: res.data.userCreated,
      membershipCreated: res.data.membershipCreated,
      profileRequested: res.data.profileRequested,
      profileApplied: res.data.profileApplied,
    }));
    close();
    router.refresh();
  }

  return (
    <>
      <button className="primary-button" type="button" onClick={() => { setNotice(null); setOpen(true); }}>
        <UserPlus size={16} aria-hidden="true" /> Add speaker
      </button>
      {notice ? <p className="settings-notice" role="status" aria-live="polite">{notice}</p> : null}

      {open ? (
        <SpeakerDialog
          title="Add a speaker"
          intro="Adds this person to the event as a speaker. If the email already has an account, that account is reused."
          submitLabel={submitting ? "Adding…" : "Add speaker"}
          submitting={submitting}
          rootError={errors._root}
          onClose={close}
          // An unexpected throw must never leave the dialog stuck behind a
          // disabled button with nothing said: clear the submitting state and
          // give the operator something to act on.
          onSubmit={() => {
            submit().catch((error) => {
              console.warn("Adding a speaker failed", error);
              setSubmitting(false);
              setErrors({ _root: speakerDialogRecovery("add") });
            });
          }}
        >
          {(ids) => (
            <>
              <label className="stack" htmlFor={`${ids}-name`}>
                <span className="field-label">Full name</span>
                <input
                  id={`${ids}-name`}
                  className="text-input"
                  autoComplete="off"
                  value={name}
                  onChange={(change) => setName(change.target.value)}
                  aria-describedby={errors.name ? `${ids}-name-error` : undefined}
                />
                {errors.name ? <span className="field-error" id={`${ids}-name-error`}>{errors.name}</span> : null}
              </label>

              <label className="stack" htmlFor={`${ids}-email`}>
                <span className="field-label">Email</span>
                <input
                  id={`${ids}-email`}
                  className="text-input"
                  type="email"
                  autoComplete="off"
                  value={email}
                  onChange={(change) => setEmail(change.target.value)}
                  aria-describedby={`${ids}-email-help`}
                />
                <span className="hint" id={`${ids}-email-help`}>
                  Identifies the account. An existing account keeps its own saved name.
                </span>
                {errors.email ? <span className="field-error">{errors.email}</span> : null}
              </label>

              <ProfileFields ids={ids} draft={draft} errors={errors} onChange={setDraft} />
            </>
          )}
        </SpeakerDialog>
      ) : null}
    </>
  );
}

export function EditSpeakerDialog({ speaker }: { speaker: EditableSpeaker }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SpeakerProfileDraft>(() => draftFromSpeaker(speaker));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  function close() {
    setOpen(false);
    setErrors({});
    setSubmitting(false);
  }

  async function submit() {
    setSubmitting(true);
    setErrors({});
    const res = await apiPatch<unknown>("/api/admin/speakers", {
      userId: speaker.userId,
      ...profilePayload(draft),
    });
    setSubmitting(false);
    if (!res.ok) {
      const mapped = firstFieldErrors(res.error.fieldErrors);
      setErrors(Object.keys(mapped).length > 0 ? mapped : { _root: res.error.message });
      return;
    }
    close();
    router.refresh();
  }

  return (
    <>
      <button
        className="ghost-button"
        type="button"
        onClick={() => {
          // Re-seed from the freshly rendered row, so reopening after a refresh
          // never edits against a stale snapshot.
          setDraft(draftFromSpeaker(speaker));
          setOpen(true);
        }}
      >
        <Pencil size={15} aria-hidden="true" /> Edit
        <span className="sr-only"> {speaker.name}&rsquo;s speaker profile</span>
      </button>

      {open ? (
        <SpeakerDialog
          title={`Edit ${speaker.name}`}
          intro="Clearing a field removes what is stored. These details appear on the public speaker page."
          submitLabel={submitting ? "Saving…" : "Save profile"}
          submitting={submitting}
          rootError={errors._root}
          onClose={close}
          onSubmit={() => {
            submit().catch((error) => {
              console.warn("Saving a speaker profile failed", error);
              setSubmitting(false);
              setErrors({ _root: speakerDialogRecovery("save") });
            });
          }}
        >
          {(ids) => (
            <>
              <div className="speaker-dialog-identity">
                <strong>{speaker.name}</strong>
                <span className="muted">{speaker.email}</span>
                <span className="hint">
                  Name and email belong to this person&rsquo;s account across every event, so they are changed by
                  the speaker, not here.
                </span>
              </div>
              <ProfileFields ids={ids} draft={draft} errors={errors} onChange={setDraft} />
            </>
          )}
        </SpeakerDialog>
      ) : null}
    </>
  );
}

function ProfileFields({
  ids,
  draft,
  errors,
  onChange,
}: {
  ids: string;
  draft: SpeakerProfileDraft;
  errors: Record<string, string>;
  onChange: (draft: SpeakerProfileDraft) => void;
}) {
  return (
    <>
      <label className="stack" htmlFor={`${ids}-status`}>
        <span className="field-label">Taking part</span>
        <select
          id={`${ids}-status`}
          className="text-input"
          value={draft.status}
          onChange={(change) => onChange({ ...draft, status: change.target.value as SpeakerConfirmation })}
          aria-describedby={`${ids}-status-help`}
        >
          {(Object.keys(SPEAKER_CONFIRMATION_LABELS) as SpeakerConfirmation[]).map((status) => (
            <option key={status} value={status}>{SPEAKER_CONFIRMATION_LABELS[status]}</option>
          ))}
        </select>
        <span className="hint" id={`${ids}-status-help`}>
          Your record of where this speaker is in accepting. Changing it sends nothing to them.
        </span>
        {errors.status ? <span className="field-error">{errors.status}</span> : null}
      </label>

      <div className="grid-2">
        <label className="stack" htmlFor={`${ids}-jobTitle`}>
          <span className="field-label">Job title <span className="muted">(optional)</span></span>
          <input
            id={`${ids}-jobTitle`}
            className="text-input"
            autoComplete="off"
            value={draft.jobTitle}
            onChange={(change) => onChange({ ...draft, jobTitle: change.target.value })}
          />
          {errors.jobTitle ? <span className="field-error">{errors.jobTitle}</span> : null}
        </label>

        <label className="stack" htmlFor={`${ids}-company`}>
          <span className="field-label">Company <span className="muted">(optional)</span></span>
          <input
            id={`${ids}-company`}
            className="text-input"
            autoComplete="off"
            value={draft.company}
            onChange={(change) => onChange({ ...draft, company: change.target.value })}
          />
          {errors.company ? <span className="field-error">{errors.company}</span> : null}
        </label>
      </div>

      <label className="stack" htmlFor={`${ids}-headshotUrl`}>
        <span className="field-label">Headshot URL <span className="muted">(optional)</span></span>
        <input
          id={`${ids}-headshotUrl`}
          className="text-input"
          type="url"
          autoComplete="off"
          placeholder="https://…"
          value={draft.headshotUrl}
          onChange={(change) => onChange({ ...draft, headshotUrl: change.target.value })}
          aria-describedby={`${ids}-headshot-help`}
        />
        <span className="hint" id={`${ids}-headshot-help`}>
          A link to an image the speaker has approved. Left empty, the roster shows their initials.
        </span>
        {errors.headshotUrl ? <span className="field-error">{errors.headshotUrl}</span> : null}
      </label>

      <label className="stack" htmlFor={`${ids}-bio`}>
        <span className="field-label">Bio <span className="muted">(optional)</span></span>
        <textarea
          id={`${ids}-bio`}
          className="text-input"
          rows={5}
          value={draft.bio}
          onChange={(change) => onChange({ ...draft, bio: change.target.value })}
        />
        {errors.bio ? <span className="field-error">{errors.bio}</span> : null}
      </label>
    </>
  );
}

/**
 * The shared modal shell. `showModal()` gives the focus trap, Esc handling and
 * inert background for free — the same pattern as the new-form dialog, so
 * nothing here hand-rolls a trap.
 */
function SpeakerDialog({
  title,
  intro,
  submitLabel,
  submitting,
  rootError,
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  intro: string;
  submitLabel: string;
  submitting: boolean;
  rootError?: string;
  onClose: () => void;
  onSubmit: () => void;
  children: (ids: string) => React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const ids = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="app-dialog speaker-dialog"
      aria-labelledby={`${ids}-title`}
      onClose={onClose}
      onCancel={onClose}
      onMouseDown={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <h2 id={`${ids}-title`}>{title}</h2>
        <p className="hint">{intro}</p>

        <div className="speaker-dialog-fields">{children(ids)}</div>

        {rootError ? <p className="field-error" role="alert">{rootError}</p> : null}

        <div className="speaker-dialog-actions">
          <button className="primary-button" type="submit" disabled={submitting}>{submitLabel}</button>
          <button className="ghost-button" type="button" disabled={submitting} onClick={onClose}>Cancel</button>
        </div>
      </form>
    </dialog>
  );
}
