"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { UserRole } from "@prisma/client";
import { Trash2, UserCog, UserPlus } from "lucide-react";
import { apiDelete, apiPatch, apiPost, firstFieldErrors } from "@/lib/api-client";
import {
  TEAM_ADDABLE_ROLES,
  TEAM_ASSIGNABLE_ROLES,
  TEAM_EXISTING_ACCOUNT_NOTE,
  TEAM_ROLE_DESCRIPTIONS,
  TEAM_ROLE_LABELS,
  teamAddNotice,
  teamDialogRecovery,
  teamRolePhrase,
  type TeamAddableRole,
} from "@/lib/team/roles";

/**
 * Add, re-role and remove event team members (`/admin/team`).
 *
 * The server is the only authority: every dialog posts to `/api/admin/team` and
 * then refreshes the RSC payload rather than patching a local list, so what the
 * operator sees afterwards is what was actually stored. Nothing here decides who
 * may write, and nothing here decides whether a guard fires — the route re-reads
 * the caller's ADMIN membership and every count under its own lock, and the
 * refusal it returns is what these dialogs display verbatim. A disabled button
 * is a courtesy, never a control.
 *
 * The one thing this surface must not do is imply an access path that does not
 * exist. An account created from here would have no password and no way to
 * obtain one — so the add takes an address that already has an account, and the
 * dialog says why before the organizer types (`TEAM_EXISTING_ACCOUNT_NOTE`)
 * rather than only when the server refuses.
 */

export type TeamMemberView = {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  /** Pre-formatted in the event's timezone by the page; never re-derived here. */
  joined: string;
  isSelf: boolean;
};

/** A single live region for the whole screen, so notices cannot stack up silently. */
function Notice({ message }: { message: string | null }) {
  return message ? <p className="settings-notice" role="status" aria-live="polite">{message}</p> : null;
}

export function AddTeamMemberDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TeamAddableRole>("EVALUATOR");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function close() {
    setOpen(false);
    setEmail("");
    setRole("EVALUATOR");
    setErrors({});
    setSubmitting(false);
  }

  async function submit() {
    // The form asks for an address and a role, and nothing else: the account it
    // resolves already stores its own name, and the route writes no `User`.
    if (email.trim() === "") {
      setErrors({ email: "An email address identifies their existing account." });
      return;
    }
    setErrors({});

    setSubmitting(true);
    setNotice(null);
    const res = await apiPost<{
      member: { userId: string; name: string; email: string; role: UserRole };
      membershipCreated: boolean;
    }>("/api/admin/team", { email: email.trim(), role });
    setSubmitting(false);
    if (!res.ok) {
      // A NO_ACCOUNT_FOR_EMAIL refusal arrives with `fieldErrors.email`, so it
      // lands beside the input that caused it; the full explanation is the
      // message, shown as the dialog's root error.
      const mapped = firstFieldErrors(res.error.fieldErrors);
      setErrors({ ...mapped, _root: res.error.message });
      return;
    }
    // The stored name, not anything typed here — which is also how the
    // organizer confirms the address matched the person they meant.
    setNotice(teamAddNotice({
      name: res.data.member.name,
      email: res.data.member.email,
      role: res.data.member.role,
      membershipCreated: res.data.membershipCreated,
    }));
    close();
    router.refresh();
  }

  return (
    <>
      <button className="primary-button" type="button" onClick={() => { setNotice(null); setOpen(true); }}>
        <UserPlus size={16} aria-hidden="true" /> Add team member
      </button>
      <Notice message={notice} />

      {open ? (
        <TeamDialog
          title="Add a team member"
          intro="Gives an existing Greenroom account access to this event as an organizer or a reviewer. Their account keeps its own saved name — this never creates one."
          submitLabel={submitting ? "Adding…" : "Add member"}
          submitting={submitting}
          rootError={errors._root}
          onClose={close}
          onSubmit={() => {
            submit().catch((error) => {
              console.warn("Adding a team member failed", error);
              setSubmitting(false);
              setErrors({ _root: teamDialogRecovery("add") });
            });
          }}
        >
          {(ids) => (
            <>
              <label className="stack" htmlFor={`${ids}-email`}>
                <span className="field-label">Email of an existing account</span>
                <input
                  id={`${ids}-email`}
                  className="text-input"
                  type="email"
                  autoComplete="off"
                  value={email}
                  onChange={(change) => setEmail(change.target.value)}
                  aria-describedby={`${ids}-email-help`}
                  aria-invalid={errors.email ? true : undefined}
                />
                <span className="hint" id={`${ids}-email-help`}>{TEAM_EXISTING_ACCOUNT_NOTE}</span>
                {errors.email ? <span className="field-error">{errors.email}</span> : null}
              </label>

              <fieldset className="team-role-choice">
                <legend className="field-label">Role</legend>
                {TEAM_ADDABLE_ROLES.map((option) => (
                  <label className="team-role-option" key={option} htmlFor={`${ids}-role-${option}`}>
                    <input
                      id={`${ids}-role-${option}`}
                      type="radio"
                      name={`${ids}-role`}
                      value={option}
                      checked={role === option}
                      onChange={() => setRole(option)}
                    />
                    <span>
                      <strong>{TEAM_ROLE_LABELS[option]}</strong>
                      <span className="hint">{TEAM_ROLE_DESCRIPTIONS[option]}</span>
                    </span>
                  </label>
                ))}
                {errors.role ? <span className="field-error">{errors.role}</span> : null}
              </fieldset>
            </>
          )}
        </TeamDialog>
      ) : null}
    </>
  );
}

/**
 * The per-row controls: change role, and remove.
 *
 * Both live in one component because they share a notice line — a refusal from
 * either has to land somewhere the operator is already looking, beside the row
 * it is about, rather than at the top of a table they may have scrolled past.
 */
export function TeamMemberActions({ member }: { member: TeamMemberView }) {
  const router = useRouter();
  const [mode, setMode] = useState<"role" | "remove" | null>(null);
  const [role, setRole] = useState<UserRole>(member.role);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function close() {
    setMode(null);
    setError(null);
    setSubmitting(false);
  }

  async function saveRole() {
    if (role === member.role) {
      setNotice(`Nothing to save — ${member.name} is already ${teamRolePhrase(member.role)}.`);
      close();
      return;
    }
    setSubmitting(true);
    setError(null);
    setNotice(null);
    const res = await apiPatch<unknown>("/api/admin/team", { userId: member.userId, role });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setNotice(
      member.isSelf
        ? `You are now ${teamRolePhrase(role)} on this event. Your own access changes on your next request.`
        : `${member.name} is now ${teamRolePhrase(role)} on this event.`,
    );
    close();
    router.refresh();
  }

  async function remove() {
    setSubmitting(true);
    setError(null);
    setNotice(null);
    const res = await apiDelete<unknown>(`/api/admin/team?userId=${encodeURIComponent(member.userId)}`);
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setNotice(`${member.name} no longer has access to this event. Their account and any past work are untouched.`);
    close();
    router.refresh();
  }

  return (
    <>
      <div className="row wrap team-actions">
        <button
          className="ghost-button"
          type="button"
          onClick={() => { setRole(member.role); setNotice(null); setError(null); setMode("role"); }}
        >
          <UserCog size={15} aria-hidden="true" /> Role
          <span className="sr-only"> — change {member.name}&rsquo;s role</span>
        </button>
        <button
          className="ghost-button danger-button"
          type="button"
          onClick={() => { setNotice(null); setError(null); setMode("remove"); }}
        >
          <Trash2 size={15} aria-hidden="true" /> Remove
          <span className="sr-only"> {member.name} from this event</span>
        </button>
      </div>
      <Notice message={notice} />

      {mode === "role" ? (
        <TeamDialog
          title={`Change ${member.name}’s role`}
          intro="Roles are re-read from the database on every request, so a change takes effect immediately — including for a session that is already signed in."
          submitLabel={submitting ? "Saving…" : "Save role"}
          submitting={submitting}
          submitDisabled={role === member.role}
          rootError={error ?? undefined}
          onClose={close}
          onSubmit={() => {
            saveRole().catch((caught) => {
              console.warn("Changing a team role failed", caught);
              setSubmitting(false);
              setError(teamDialogRecovery("save"));
            });
          }}
        >
          {(ids) => (
            <>
              <div className="team-dialog-identity">
                <strong>{member.name}</strong>
                <span className="muted">{member.email}</span>
              </div>
              {member.isSelf ? (
                <p className="hint" role="note">
                  This is your own membership. Stepping down from organizer removes your access to this
                  screen — you would need another organizer to put you back.
                </p>
              ) : null}
              <fieldset className="team-role-choice">
                <legend className="field-label">Role</legend>
                {TEAM_ASSIGNABLE_ROLES.map((option) => (
                  <label className="team-role-option" key={option} htmlFor={`${ids}-role-${option}`}>
                    <input
                      id={`${ids}-role-${option}`}
                      type="radio"
                      name={`${ids}-role`}
                      value={option}
                      checked={role === option}
                      onChange={() => setRole(option)}
                    />
                    <span>
                      <strong>{TEAM_ROLE_LABELS[option]}</strong>
                      <span className="hint">{TEAM_ROLE_DESCRIPTIONS[option]}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            </>
          )}
        </TeamDialog>
      ) : null}

      {mode === "remove" ? (
        <TeamDialog
          title={`Remove ${member.name}?`}
          intro="This removes their access to this event only. Their Greenroom account, and anything they have already written, stay exactly as they are."
          submitLabel={submitting ? "Removing…" : "Remove from event"}
          submitting={submitting}
          destructive
          rootError={error ?? undefined}
          onClose={close}
          onSubmit={() => {
            remove().catch((caught) => {
              console.warn("Removing a team member failed", caught);
              setSubmitting(false);
              setError(teamDialogRecovery("remove"));
            });
          }}
        >
          {() => (
            <div className="team-dialog-identity">
              <strong>{member.name}</strong>
              <span className="muted">{member.email} · {TEAM_ROLE_LABELS[member.role]}</span>
              {member.isSelf ? (
                <span className="hint">
                  This is your own membership. Removing it signs you out of this event, and only another
                  organizer could add you back.
                </span>
              ) : null}
            </div>
          )}
        </TeamDialog>
      ) : null}
    </>
  );
}

/**
 * The shared modal shell. `showModal()` gives the focus trap, Esc handling and
 * inert background for free — the same native `<dialog>` pattern the speaker
 * and form dialogs use, so nothing here hand-rolls a trap.
 */
function TeamDialog({
  title,
  intro,
  submitLabel,
  submitting,
  submitDisabled,
  destructive,
  rootError,
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  intro: string;
  submitLabel: string;
  submitting: boolean;
  submitDisabled?: boolean;
  /** Styles the confirm as the dangerous action it is; nothing else changes. */
  destructive?: boolean;
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
      className="app-dialog team-dialog"
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

        <div className="team-dialog-fields">{children(ids)}</div>

        {rootError ? <p className="field-error" role="alert">{rootError}</p> : null}

        <div className="team-dialog-actions">
          <button
            className={destructive ? "ghost-button danger-button" : "primary-button"}
            type="submit"
            disabled={submitting || submitDisabled === true}
          >
            {submitLabel}
          </button>
          <button className="ghost-button" type="button" disabled={submitting} onClick={onClose}>Cancel</button>
        </div>
      </form>
    </dialog>
  );
}
