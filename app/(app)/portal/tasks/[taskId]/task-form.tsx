"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Save } from "lucide-react";
import { FieldControl, type RenderField } from "@/components/field-renderer";
import { FileUploadField } from "@/components/file-upload-field";
import { isFieldVisible, type AnswerMap, type AnswerValue } from "@/lib/form-logic";
import type { TaskFormField, TaskResponses } from "@/lib/portal/task-form";
import {
  isUploadedTaskArtifact,
  taskArtifactHref,
  taskArtifactSubmission,
} from "@/lib/portal/task-artifact";
import { formatEventDateTime } from "@/lib/tz";
import styles from "../../portal.module.css";

/**
 * Fill in the form attached to an onboarding task.
 *
 * Two deliberate affordances: **Save progress** (keeps the task in progress, so
 * a speaker can come back to a flight-reimbursement form when they have the
 * receipt) and **Save and mark done**, which the server refuses unless the form
 * is actually complete. A task that says "done" with an empty form is exactly
 * the false signal this feature exists to remove.
 */
export function TaskForm({
  taskId,
  formName,
  required,
  dueAt,
  status,
  timezone,
  fields,
  initialResponses,
  initialArtifactUrl,
}: {
  taskId: string;
  formName: string | null;
  required: boolean;
  dueAt: string | null;
  status: string;
  timezone: string;
  fields: TaskFormField[];
  initialResponses: TaskResponses;
  /** The deliverable already recorded on this assignment, link or uploaded path. */
  initialArtifactUrl: string | null;
}) {
  const [responses, setResponses] = useState<AnswerMap>({ ...(initialResponses as AnswerMap) });
  const [artifact, setArtifact] = useState(initialArtifactUrl ?? "");
  const [taskStatus, setTaskStatus] = useState(status);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [message, setMessage] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const visibleFields = useMemo(
    () => fields.filter((field) => isFieldVisible(field as never, responses)),
    [fields, responses],
  );

  async function save(nextStatus: "IN_PROGRESS" | "COMPLETED") {
    setBusy(true);
    setMessage(null);
    setFieldErrors({});
    try {
      const res = await fetch("/api/portal/tasks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId,
          status: nextStatus,
          // Only questions currently on screen are sent; the server merges by
          // key, so answers to hidden or untouched questions are preserved.
          // Omitted entirely for a task with no form, which the route refuses to
          // accept responses for at all.
          ...(fields.length === 0
            ? {}
            : {
              responses: Object.fromEntries(
                visibleFields.map((field) => [field.key, responses[field.key] ?? null]),
              ),
            }),
          // One field, two keys: an uploaded file travels as an id the server
          // verifies, a pasted link as the URL it already accepted. Which one
          // is decided by the field's own value, not by which control was used
          // last (`lib/portal/task-artifact.ts`).
          ...taskArtifactSubmission(artifact),
        }),
      });
      const body = await res.json();
      if (!body?.ok) {
        setFieldErrors(body?.error?.fieldErrors ?? {});
        setMessage({
          tone: "bad",
          text: body?.error?.message ?? "That could not be saved. Please try again.",
        });
        return;
      }
      setTaskStatus(body.data.status);
      setMessage({
        tone: "good",
        text: body.data.status === "COMPLETED" ? "Done — thanks, that's one less thing." : "Saved. Come back any time to finish it.",
      });
    } catch {
      setMessage({ tone: "bad", text: "We couldn't reach the server. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  const done = taskStatus === "COMPLETED";
  const due = formatEventDateTime(dueAt, timezone);

  /**
   * The deliverable itself: one text field, filled two ways.
   *
   * Exactly the profile form's either/or pattern — the uploader does not own the
   * value, it fills the field beside it, and the field is still what gets sent.
   * So a pasted link keeps working unchanged, an upload is an alternative way to
   * fill the same one field, and the two can never both be in play at once.
   *
   * The one difference from the profile form is what travels on the wire: an
   * uploaded artifact goes as its stored id rather than as the path, because the
   * server writes that path itself after checking the file is the caller's own.
   */
  const artifactHref = taskArtifactHref(artifact);
  const artifactBlock = (
    <>
      <label className={styles.field}>
        <span>Deliverable link (optional)</span>
        <input
          value={artifact}
          onChange={(e) => setArtifact(e.target.value)}
          placeholder="https://…"
          inputMode="url"
          disabled={busy}
        />
      </label>
      <FileUploadField
        kind="TASK_ARTIFACT"
        label="…or upload a file"
        hint="PDF, PNG, JPEG or WebP. Only you and this event's organizers can open it."
        disabled={busy}
        onUploaded={(url) => setArtifact(url)}
      />
      {artifactHref ? (
        <p className={styles.taskMeta}>
          {isUploadedTaskArtifact(artifact) ? "Uploaded file: " : "Link: "}
          {/* Only ever an app path or an http(s) URL — a stored value that is
              neither is shown as text below rather than made clickable. */}
          <a href={artifactHref} rel="noreferrer">Open what you attached</a>
          {isUploadedTaskArtifact(artifact) ? " (saved once you save this task)" : ""}
        </p>
      ) : artifact.trim() ? (
        <p className={styles.taskMeta}>
          That does not look like a web link, so it is stored as text: {artifact.trim()}
        </p>
      ) : null}
    </>
  );

  if (fields.length === 0) {
    return (
      <form className={styles.card} onSubmit={(event) => { event.preventDefault(); save("COMPLETED"); }}>
        <div className={styles.cardHead}>
          <div>
            <h2>Your deliverable</h2>
            <p>
              {required ? "Required" : "Optional"}
              {due ? ` · due ${due}` : ""}
              {done ? " · completed" : ""}
            </p>
          </div>
        </div>
        <p className={styles.taskMeta}>
          This task has no form to fill in. Attach what it asks for below, or tick it off from your portal.
        </p>
        {artifactBlock}

        {message ? (
          <p className={message.tone === "good" ? styles.saveNote : styles.saveError} role={message.tone === "good" ? "status" : "alert"}>
            {message.tone === "good" ? <Check size={14} aria-hidden="true" /> : null} {message.text}
          </p>
        ) : null}

        <div className={styles.formActions}>
          <Link className="ghost-button" href="/portal"><ArrowLeft size={15} aria-hidden="true" /> Back to your portal</Link>
          {done ? null : (
            <button className="ghost-button" type="button" onClick={() => save("IN_PROGRESS")} disabled={busy}>
              <Save size={15} aria-hidden="true" /> Save progress
            </button>
          )}
          <button className="primary-button" type="submit" disabled={busy}>
            <Check size={15} aria-hidden="true" /> {busy ? "Saving…" : done ? "Save changes" : "Save and mark done"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form className={styles.card} onSubmit={(event) => { event.preventDefault(); save("COMPLETED"); }}>
      <div className={styles.cardHead}>
        <div>
          <h2>{formName ?? "Your details"}</h2>
          <p>
            {required ? "Required" : "Optional"}
            {due ? ` · due ${due}` : ""}
            {done ? " · completed" : ""}
          </p>
        </div>
      </div>

      {visibleFields.map((field) => (
        <FieldControl
          key={field.id}
          field={field as RenderField}
          value={responses[field.key] as AnswerValue}
          onChange={(value) => setResponses((current) => ({ ...current, [field.key]: value }))}
          error={fieldErrors[field.key]?.join(" ") ?? null}
          idPrefix="task"
        />
      ))}

      {artifactBlock}

      {message ? (
        <p className={message.tone === "good" ? styles.saveNote : styles.saveError} role={message.tone === "good" ? "status" : "alert"}>
          {message.tone === "good" ? <Check size={14} aria-hidden="true" /> : null} {message.text}
        </p>
      ) : null}

      <div className={styles.formActions}>
        <Link className="ghost-button" href="/portal"><ArrowLeft size={15} aria-hidden="true" /> Back to your portal</Link>
        {done ? null : (
          <button className="ghost-button" type="button" onClick={() => save("IN_PROGRESS")} disabled={busy}>
            <Save size={15} aria-hidden="true" /> Save progress
          </button>
        )}
        <button className="primary-button" type="submit" disabled={busy}>
          <Check size={15} aria-hidden="true" /> {busy ? "Saving…" : done ? "Save changes" : "Save and mark done"}
        </button>
      </div>
    </form>
  );
}
