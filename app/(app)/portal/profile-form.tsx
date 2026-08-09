"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { profileFormValues, profilePatch, type PortalProfile } from "@/lib/portal/profile";
import styles from "./portal.module.css";

export type { PortalProfile } from "@/lib/portal/profile";

const MAX_BIO = 3000;

export function ProfileForm({ profile }: { profile: PortalProfile }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [form, setForm] = useState(profile);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof PortalProfile>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);

    const payload = profilePatch(profile, form);

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
        setForm(profileFormValues(body.data));
        setSaved(true);
        startTransition(() => router.refresh());
      }
    } catch {
      setError("Network error while saving your profile.");
    } finally {
      setSaving(false);
    }
  }

  const dirty = Object.keys(profilePatch(profile, form)).length > 0;

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
      <label className={styles.field}>
        <span>Slide deck URL</span>
        <input
          value={form.slideDeckUrl}
          onChange={(e) => update("slideDeckUrl", e.target.value)}
          placeholder="https://…"
          inputMode="url"
        />
      </label>

      <div className={styles.formActions}>
        <button className="primary-button" type="submit" disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save profile"}
        </button>
        {saved ? <span className={styles.saveNote} role="status">Saved</span> : null}
        {error ? <span className={styles.saveError} role="alert">{error}</span> : null}
      </div>
    </form>
  );
}
