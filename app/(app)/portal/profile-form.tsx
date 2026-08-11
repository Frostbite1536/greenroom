"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileUploadField } from "@/components/file-upload-field";
import {
  profileFormValues,
  profilePatch,
  reconcileSavedProfile,
  type PortalProfile,
} from "@/lib/portal/profile";
import styles from "./portal.module.css";

export type { PortalProfile } from "@/lib/portal/profile";

const MAX_BIO = 3000;

export function ProfileForm({ profile }: { profile: PortalProfile }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [baseline, setBaseline] = useState(profile);
  const [form, setForm] = useState(profile);
  const formRef = useRef(profile);
  const [saving, setSaving] = useState(false);
  // The confirmation itself, not a flag. A save that landed while the speaker
  // kept typing is still a save: the old boolean went false in exactly that
  // case, so a successful write reported neither success nor failure and the
  // button simply re-enabled.
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof PortalProfile>(key: K, value: string) {
    const next = { ...formRef.current, [key]: value };
    formRef.current = next;
    setForm(next);
    setSaved(null);
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    setSaved(null);

    const submitted = formRef.current;
    const payload = profilePatch(baseline, submitted);

    try {
      const res = await fetch("/api/portal/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.ok !== true) {
        const fieldErrors = body?.error?.fieldErrors as Record<string, string[]> | undefined;
        const first = fieldErrors ? Object.entries(fieldErrors)[0] : undefined;
        setError(first ? `${first[0]}: ${first[1][0]}` : (body?.error?.message ?? "Could not save your profile."));
      } else {
        const savedProfile = profileFormValues(body.data);
        const reconciled = reconcileSavedProfile(submitted, formRef.current, savedProfile);
        formRef.current = reconciled;
        setBaseline(savedProfile);
        setForm(reconciled);
        // Either way the write succeeded and is confirmed; the difference is
        // only whether what is on screen now still matches what was stored.
        setSaved(
          Object.keys(profilePatch(savedProfile, reconciled)).length === 0
            ? "Profile saved."
            : "Profile saved — you have edited it again since, so save once more to store those changes.",
        );
        startTransition(() => router.refresh());
      }
    } catch {
      setError("Network error while saving your profile.");
    } finally {
      setSaving(false);
    }
  }

  const dirty = Object.keys(profilePatch(baseline, form)).length > 0;

  return (
    <form onSubmit={onSubmit}>
      <p className={styles.taskMeta}>Clear a field, then save, to remove its value. Unchanged fields are preserved.</p>
      <label className={styles.field}>
        <span>Job title</span>
        <input value={form.jobTitle} onChange={(e) => update("jobTitle", e.target.value)} maxLength={160} />
      </label>
      <label className={styles.field}>
        <span>Company</span>
        <input value={form.company} onChange={(e) => update("company", e.target.value)} maxLength={160} />
      </label>
      <label className={styles.field}>
        <span>Speaker bio</span>
        <textarea
          value={form.bio}
          onChange={(e) => update("bio", e.target.value)}
          maxLength={MAX_BIO}
          aria-describedby="bio-count"
        />
      </label>
      <p className={styles.taskMeta} id="bio-count">
        {form.bio.length} / {MAX_BIO} characters
      </p>
      <label className={styles.field}>
        <span>Headshot URL</span>
        <input
          value={form.headshotUrl}
          onChange={(e) => update("headshotUrl", e.target.value)}
          placeholder="https://…"
          inputMode="url"
        />
      </label>
      {/* Either/or, never both: uploading fills the field above, and the field
          is still what gets saved — so a pasted link keeps working unchanged
          and clearing it still clears the profile. */}
      <FileUploadField
        kind="HEADSHOT"
        label="…or upload a headshot"
        hint="PNG, JPEG or WebP."
        onUploaded={(url) => update("headshotUrl", url)}
      />
      <label className={styles.field}>
        <span>Slide deck URL</span>
        <input
          value={form.slideDeckUrl}
          onChange={(e) => update("slideDeckUrl", e.target.value)}
          placeholder="https://…"
          inputMode="url"
        />
      </label>
      <FileUploadField
        kind="SLIDE_DECK"
        label="…or upload a slide deck"
        hint="PDF. Only you and the organizers can open it."
        onUploaded={(url) => update("slideDeckUrl", url)}
      />

      <div className={styles.formActions}>
        <button className="primary-button" type="submit" disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save profile"}
        </button>
        {saved ? <span className={styles.saveNote} role="status">{saved}</span> : null}
        {error ? <span className={styles.saveError} role="alert">{error}</span> : null}
      </div>
    </form>
  );
}
