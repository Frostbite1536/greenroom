"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Save } from "lucide-react";
import { FieldControl, type RenderField } from "@/components/field-renderer";
import { isFieldVisible, type AnswerMap, type AnswerValue } from "@/lib/form-logic";
import type { TaskFormField, TaskResponses } from "@/lib/portal/task-form";
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
}: {
  taskId: string;
  formName: string | null;
  required: boolean;
  dueAt: string | null;
  status: string;
  timezone: string;
  fields: TaskFormField[];
  initialResponses: TaskResponses;
}) {
  const [responses, setResponses] = useState<AnswerMap>({ ...(initialResponses as AnswerMap) });
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
          responses: Object.fromEntries(visibleFields.map((field) => [field.key, responses[field.key] ?? null])),
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

  if (fields.length === 0) {
    return (
      <section className={styles.card}>
        <p className={styles.empty}>This task has no form to fill in — you can tick it off from your portal.</p>
        <Link className="ghost-button" href="/portal"><ArrowLeft size={15} aria-hidden="true" /> Back to your portal</Link>
      </section>
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
