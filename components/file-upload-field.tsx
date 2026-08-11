"use client";

import { useId, useState } from "react";
import {
  STORED_FILE_LIMITS,
  storedFileMaxBytes,
  type StoredFileKindValue,
} from "@/lib/uploads/stored-file";

/**
 * Upload one file and hand back the URL it is served from.
 *
 * Deliberately the smallest island that can do the job: it owns a file input,
 * one in-flight flag and one error string, and it reports a `/api/files/<id>`
 * URL upward. It does **not** own the URL field beside it — the parent form
 * still holds that value and still submits it, so uploading and pasting a link
 * remain the same one field with two ways to fill it, and clearing it is still
 * the same clear.
 *
 * The body is the raw file with its own content type as the header. The server
 * re-derives the type from the bytes regardless (`lib/uploads/stored-file.ts`),
 * so a browser that guesses `application/octet-stream` for a real PNG is
 * refused rather than stored — which is the honest outcome, since the same
 * mismatch would be a lie if we accepted it.
 */
export function FileUploadField({
  kind,
  label,
  hint,
  onUploaded,
}: {
  kind: StoredFileKindValue;
  label: string;
  hint?: string;
  /** Called with the served URL once the file is stored. */
  onUploaded: (url: string) => void;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const maxBytes = storedFileMaxBytes(kind);
  const accept = STORED_FILE_LIMITS[kind].mimes.join(",");
  const maxLabel = `${Math.floor(maxBytes / 1024 / 1024)} MB`;

  async function upload(file: File) {
    setError(null);
    setDone(null);
    // A client-side check for the common case only. The server enforces the
    // same cap against the stream, so this is a courtesy, never the guard.
    if (file.size > maxBytes) {
      setError(`That file is ${Math.ceil(file.size / 1024 / 1024)} MB. The limit is ${maxLabel}.`);
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(`/api/files?kind=${kind === "HEADSHOT" ? "headshot" : "slide-deck"}`, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.ok !== true) {
        setError(body?.error?.message ?? "The upload failed. Try again.");
        return;
      }
      onUploaded(body.data.url as string);
      setDone(file.name);
    } catch {
      setError("Network error while uploading. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <label className="field-label" htmlFor={id}>{label}</label>
      <input
        id={id}
        type="file"
        accept={accept}
        disabled={busy}
        aria-describedby={`${id}-hint`}
        onChange={(change) => {
          const file = change.target.files?.[0];
          // Reset the control so re-picking the same file fires again after an
          // error: without this, a retry of the identical file is a no-op.
          change.target.value = "";
          if (file) void upload(file);
        }}
      />
      <span className="hint" id={`${id}-hint`}>
        {hint ? `${hint} ` : ""}Up to {maxLabel}. Uploading fills the link field above; you can still paste a link instead.
      </span>
      {busy ? <span className="hint" role="status">Uploading…</span> : null}
      {done ? <span className="hint" role="status">Uploaded {done}.</span> : null}
      {error ? <span className="field-error" role="alert">{error}</span> : null}
    </div>
  );
}
