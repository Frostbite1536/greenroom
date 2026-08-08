"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import styles from "./portal.module.css";

export type PortalTask = {
  taskId: string;
  title: string;
  description: string | null;
  required: boolean;
  dueAt: string | null;
  hasForm: boolean;
  status: "TODO" | "IN_PROGRESS" | "COMPLETED" | "WAIVED";
};

function formatDue(dueAt: string | null, timezone: string): string | null {
  if (!dueAt) return null;
  return new Date(dueAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: timezone,
  });
}

export function TaskChecklist({ tasks, timezone }: { tasks: PortalTask[]; timezone: string }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  // Optimistic overrides keyed by taskId, so the checkbox responds instantly.
  const [overrides, setOverrides] = useState<Record<string, PortalTask["status"]>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const statusOf = (task: PortalTask) => overrides[task.taskId] ?? task.status;
  const done = tasks.filter((t) => statusOf(t) === "COMPLETED" || statusOf(t) === "WAIVED").length;
  const pct = tasks.length === 0 ? 0 : Math.round((done / tasks.length) * 100);

  async function toggle(task: PortalTask, checked: boolean) {
    const next: PortalTask["status"] = checked ? "COMPLETED" : "TODO";
    const previous = statusOf(task);
    setOverrides((o) => ({ ...o, [task.taskId]: next }));
    setPending((p) => ({ ...p, [task.taskId]: true }));
    setError(null);

    try {
      const res = await fetch("/api/portal/tasks", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: task.taskId, status: next }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.ok !== true) {
        // Roll the optimistic update back.
        setOverrides((o) => ({ ...o, [task.taskId]: previous }));
        setError(body?.error?.message ?? "Could not save that task. Please try again.");
      } else {
        startTransition(() => router.refresh());
      }
    } catch {
      setOverrides((o) => ({ ...o, [task.taskId]: previous }));
      setError("Network error while saving your task.");
    } finally {
      setPending((p) => ({ ...p, [task.taskId]: false }));
    }
  }

  if (tasks.length === 0) {
    return <p className={styles.empty}>No onboarding tasks assigned yet. They appear once a session is confirmed.</p>;
  }

  return (
    <>
      <div className={styles.progressTrack} role="presentation">
        <div className={styles.progressFill} style={{ width: `${pct}%` }} />
      </div>
      <p className={styles.taskMeta} aria-live="polite">
        {done} of {tasks.length} complete ({pct}%)
      </p>
      {error ? <p className={styles.saveError} role="alert">{error}</p> : null}

      <ul className={styles.taskList}>
        {tasks.map((task) => {
          const status = statusOf(task);
          const isDone = status === "COMPLETED" || status === "WAIVED";
          const due = formatDue(task.dueAt, timezone);
          return (
            <li className={`${styles.task} ${isDone ? styles.taskDone : ""}`} key={task.taskId}>
              <input
                className={styles.toggle}
                type="checkbox"
                checked={isDone}
                // A form-carrying task is completed by filling the form in; the
                // server refuses the shortcut anyway, so don't offer it here.
                disabled={pending[task.taskId] || (task.hasForm && !isDone)}
                onChange={(e) => toggle(task, e.target.checked)}
                aria-label={
                  task.hasForm && !isDone
                    ? `Open the form for "${task.title}" to complete it`
                    : `Mark "${task.title}" as ${isDone ? "not complete" : "complete"}`
                }
              />
              <div className={styles.taskBody}>
                <div className={styles.taskTitle}>
                  <span>{task.title}</span>
                  {task.required ? <span className={`${styles.pill} ${styles.pillRequired}`}>Required</span> : null}
                  {task.hasForm ? <span className={`${styles.pill} ${styles.pillForm}`}>Form</span> : null}
                  {status === "WAIVED" ? <span className={`${styles.pill} ${styles.pillDone}`}>Waived</span> : null}
                </div>
                {task.description ? <p className={styles.taskMeta}>{task.description}</p> : null}
                {due ? <p className={styles.taskMeta}>Due {due}</p> : null}
                {task.hasForm ? (
                  <a className="link-button" href={`/portal/tasks/${task.taskId}`}>
                    {isDone ? "Review your answers" : "Fill in the form"}
                  </a>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
