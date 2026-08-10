"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ListChecks, Plus, Trash2, UsersRound } from "lucide-react";
import { apiDelete, apiPatch, apiPost, firstFieldErrors } from "@/lib/api-client";
import { formatEventDateTime } from "@/lib/tz";
import { bulkAssignNotice, taskFanOutNotice } from "@/lib/speakers/task-notices";
import type { OnboardingTaskView } from "@/lib/services/onboarding-task-view";
import { EmptyState, Pill } from "@/components/ui";

/**
 * Onboarding-task authoring for organizers (CNT-01/SPK-05).
 *
 * The server is the only authority here: every action posts to
 * `/api/admin/tasks`, and success refreshes the RSC payload rather than
 * patching a local list. A refusal — a duplicate title, or a task speakers have
 * already answered — leaves the row exactly where it is, because a 409 means it
 * is still real event data.
 */
export type TaskFormOption = { id: string; name: string };

type TaskDraft = {
  title: string;
  description: string;
  dueOn: string;
  required: boolean;
  formConfigId: string;
};

const EMPTY_DRAFT: TaskDraft = { title: "", description: "", dueOn: "", required: true, formConfigId: "" };

function draftFromTask(task: OnboardingTaskView): TaskDraft {
  return {
    title: task.title,
    description: task.description ?? "",
    dueOn: task.dueOn ?? "",
    required: task.required,
    formConfigId: task.formConfigId ?? "",
  };
}

/**
 * Only send what the operator can actually set. `dueOn` and `formConfigId` are
 * always sent on an edit — including as `null` — so clearing a deadline or
 * unlinking a form is a real instruction rather than an omission the server
 * would read as "leave it alone".
 */
function payloadFromDraft(draft: TaskDraft) {
  return {
    title: draft.title.trim(),
    description: draft.description.trim() === "" ? null : draft.description.trim(),
    dueOn: draft.dueOn === "" ? null : draft.dueOn,
    required: draft.required,
    formConfigId: draft.formConfigId === "" ? null : draft.formConfigId,
  };
}

export function OnboardingTaskManager({
  tasks,
  forms,
  timezone,
  confirmedSpeakers,
}: {
  tasks: OnboardingTaskView[];
  forms: TaskFormOption[];
  timezone: string;
  confirmedSpeakers: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<TaskDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<TaskDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function refresh() {
    startTransition(() => router.refresh());
  }

  function reset() {
    setError(null);
    setNotice(null);
  }

  async function createTask() {
    if (draft.title.trim() === "") {
      setError("Give the task a title.");
      return;
    }
    setBusy("new");
    reset();
    const res = await apiPost<{ task: OnboardingTaskView; assigned: number; sessions: number }>(
      "/api/admin/tasks",
      payloadFromDraft(draft),
    );
    setBusy(null);
    if (!res.ok) {
      const fields = firstFieldErrors(res.error.fieldErrors);
      setError(fields.title ?? fields.formConfigId ?? fields.dueOn ?? res.error.message);
      return;
    }
    setDraft(EMPTY_DRAFT);
    // `required` comes from the stored task the server returned, not the local
    // draft: the notice must describe what was actually persisted.
    setNotice(taskFanOutNotice({
      verb: "Added",
      title: res.data.task.title,
      required: res.data.task.required,
      assigned: res.data.assigned,
      sessions: res.data.sessions,
    }));
    refresh();
  }

  async function saveTask(taskId: string) {
    if (editDraft.title.trim() === "") {
      setError("Give the task a title.");
      return;
    }
    setBusy(taskId);
    reset();
    const res = await apiPatch<{ task: OnboardingTaskView; assigned: number; sessions: number }>("/api/admin/tasks", {
      id: taskId,
      ...payloadFromDraft(editDraft),
    });
    setBusy(null);
    if (!res.ok) {
      const fields = firstFieldErrors(res.error.fieldErrors);
      setError(fields.title ?? fields.formConfigId ?? fields.dueOn ?? res.error.message);
      return;
    }
    setEditingId(null);
    setNotice(taskFanOutNotice({
      verb: "Saved",
      title: res.data.task.title,
      required: res.data.task.required,
      assigned: res.data.assigned,
      sessions: res.data.sessions,
    }));
    refresh();
  }

  async function removeTask(task: OnboardingTaskView) {
    if (!window.confirm(`Remove “${task.title}”? This is only possible while no speaker has worked on it.`)) return;
    setBusy(`delete:${task.id}`);
    reset();
    const res = await apiDelete<{ task: OnboardingTaskView }>(
      `/api/admin/tasks?taskId=${encodeURIComponent(task.id)}`,
    );
    setBusy(null);
    if (!res.ok) {
      // Never drop the row locally: a refusal means it is still real event data
      // and the speaker answers behind it are still there.
      setError(res.error.message);
      return;
    }
    setNotice(`Removed “${res.data.task.title}”.`);
    refresh();
  }

  async function assignAll() {
    setBusy("assign");
    reset();
    const res = await apiPost<{ assigned: number; sessions: number }>("/api/admin/tasks/assign", {});
    setBusy(null);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setNotice(bulkAssignNotice(res.data.assigned, res.data.sessions));
    refresh();
  }

  const anyBusy = busy !== null || pending;

  return (
    <section className="card settings-card" aria-labelledby="onboarding-tasks-heading">
      <div className="settings-heading">
        <div className="settings-icon"><ListChecks size={18} aria-hidden="true" /></div>
        <div>
          <h2 id="onboarding-tasks-heading">Onboarding checklist</h2>
          <p>
            The tasks every confirmed speaker is asked to complete. A required task is assigned to all{" "}
            {confirmedSpeakers} confirmed speaker{confirmedSpeakers === 1 ? "" : "s"} the moment you save it.
          </p>
        </div>
      </div>

      <TaskFields
        idPrefix="new-task"
        draft={draft}
        forms={forms}
        onChange={setDraft}
        disabled={anyBusy}
        onSubmit={() => void createTask()}
        submitLabel={busy === "new" ? "Adding…" : "Add task"}
        submitIcon={<Plus size={16} aria-hidden="true" />}
      />

      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {notice ? <p className="settings-notice" role="status" aria-live="polite">{notice}</p> : null}

      {tasks.length === 0 ? (
        <EmptyState icon={<ListChecks size={22} aria-hidden="true" />} title="No onboarding tasks yet">
          Add the first task above — required tasks reach every confirmed speaker immediately.
        </EmptyState>
      ) : (
        <div className="table-scroll settings-table-scroll">
          <table className="data-table">
            <caption className="sr-only">Onboarding task templates with due dates and assignment progress</caption>
            <thead>
              <tr>
                <th scope="col">Task</th>
                <th scope="col">Due</th>
                <th scope="col">Required</th>
                <th scope="col">Assigned</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const linkedForm = forms.find((form) => form.id === task.formConfigId);
                if (editingId === task.id) {
                  return (
                    <tr key={task.id}>
                      <td colSpan={5}>
                        <TaskFields
                          idPrefix={`task-${task.id}`}
                          draft={editDraft}
                          forms={forms}
                          onChange={setEditDraft}
                          disabled={anyBusy}
                          onSubmit={() => void saveTask(task.id)}
                          submitLabel={busy === task.id ? "Saving…" : "Save task"}
                          onCancel={() => setEditingId(null)}
                        />
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={task.id}>
                    <td>
                      <div className="cell-title">{task.title}</div>
                      {task.description ? <div className="cell-sub">{task.description}</div> : null}
                      {linkedForm ? <div className="cell-sub">Form: {linkedForm.name}</div> : null}
                    </td>
                    <td>
                      {task.dueAt
                        ? formatEventDateTime(task.dueAt, timezone)
                        : <span className="muted">No deadline</span>}
                    </td>
                    <td>{task.required ? <Pill tone="warn">Required</Pill> : <Pill tone="neutral">Optional</Pill>}</td>
                    <td>
                      {task.assignedCount === 0
                        ? <span className="muted">Nobody yet</span>
                        : `${task.settledCount} / ${task.assignedCount} done`}
                    </td>
                    <td>
                      <div className="row wrap settings-row-actions">
                        <button
                          className="ghost-button"
                          type="button"
                          disabled={anyBusy}
                          onClick={() => {
                            reset();
                            setEditDraft(draftFromTask(task));
                            setEditingId(task.id);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          className="ghost-button danger-button"
                          type="button"
                          disabled={anyBusy}
                          onClick={() => void removeTask(task)}
                        >
                          <Trash2 size={15} aria-hidden="true" />{" "}
                          {busy === `delete:${task.id}` ? "Working…" : "Remove"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="row wrap settings-row-actions">
        <button className="ghost-button" type="button" disabled={anyBusy || tasks.length === 0} onClick={() => void assignAll()}>
          <UsersRound size={15} aria-hidden="true" />{" "}
          {busy === "assign" ? "Assigning…" : "Assign checklist to all confirmed speakers"}
        </button>
      </div>
      <p className="hint">
        Assigning is safe to repeat: speakers who already hold a task keep their answers and progress untouched.
      </p>
    </section>
  );
}

function TaskFields({
  idPrefix,
  draft,
  forms,
  onChange,
  onSubmit,
  onCancel,
  disabled,
  submitLabel,
  submitIcon,
}: {
  idPrefix: string;
  draft: TaskDraft;
  forms: TaskFormOption[];
  onChange: (draft: TaskDraft) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  disabled: boolean;
  submitLabel: string;
  submitIcon?: React.ReactNode;
}) {
  return (
    <form
      className="settings-form"
      onSubmit={(formEvent) => {
        formEvent.preventDefault();
        onSubmit();
      }}
    >
      <label className="stack" htmlFor={`${idPrefix}-title`}>
        <span className="field-label">Task title</span>
        <input
          id={`${idPrefix}-title`}
          className="text-input"
          name={`${idPrefix}-title`}
          autoComplete="off"
          value={draft.title}
          onChange={(change) => onChange({ ...draft, title: change.target.value })}
        />
      </label>

      <label className="stack" htmlFor={`${idPrefix}-description`}>
        <span className="field-label">What the speaker needs to do <span className="muted">(optional)</span></span>
        <input
          id={`${idPrefix}-description`}
          className="text-input"
          name={`${idPrefix}-description`}
          autoComplete="off"
          value={draft.description}
          onChange={(change) => onChange({ ...draft, description: change.target.value })}
        />
      </label>

      <div className="grid-2">
        <label className="stack" htmlFor={`${idPrefix}-due`}>
          <span className="field-label">Due date <span className="muted">(optional)</span></span>
          <input
            id={`${idPrefix}-due`}
            className="text-input"
            type="date"
            name={`${idPrefix}-due`}
            value={draft.dueOn}
            onChange={(change) => onChange({ ...draft, dueOn: change.target.value })}
            aria-describedby={`${idPrefix}-due-help`}
          />
          <span className="hint" id={`${idPrefix}-due-help`}>Due by the end of that day, in the event&rsquo;s own time zone.</span>
        </label>

        <label className="stack" htmlFor={`${idPrefix}-form`}>
          <span className="field-label">Form to fill in <span className="muted">(optional)</span></span>
          <select
            id={`${idPrefix}-form`}
            className="select-input"
            name={`${idPrefix}-form`}
            value={draft.formConfigId}
            onChange={(change) => onChange({ ...draft, formConfigId: change.target.value })}
          >
            <option value="">No form — a simple checklist item</option>
            {forms.map((form) => <option key={form.id} value={form.id}>{form.name}</option>)}
          </select>
        </label>
      </div>

      <label className="row" htmlFor={`${idPrefix}-required`}>
        <input
          id={`${idPrefix}-required`}
          type="checkbox"
          name={`${idPrefix}-required`}
          checked={draft.required}
          onChange={(change) => onChange({ ...draft, required: change.target.checked })}
        />
        <span className="field-label">Required — this task blocks the speaker from being ready</span>
      </label>

      <div className="row wrap settings-row-actions">
        <button className="primary-button" type="submit" disabled={disabled}>
          {submitIcon}{submitIcon ? " " : null}{submitLabel}
        </button>
        {onCancel ? (
          <button className="ghost-button" type="button" disabled={disabled} onClick={onCancel}>Cancel</button>
        ) : null}
      </div>
    </form>
  );
}
