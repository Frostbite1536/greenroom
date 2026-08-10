import { z } from "zod";
import type { AbstractStatus, EvaluationAssignmentStatus } from "@prisma/client";
import { coSpeakerInputSchema, formAnswerValueSchema, idSchema } from "@/types/api";
import type { FormAnswerValue } from "@/lib/services/types";

/**
 * Pure rules for R1: a speaker editing their own submission after it has been
 * submitted or accepted (requirements delta 2026-08-08, confirmed by the
 * competition lead). Kept database-free so the authorization and status rules
 * are unit-testable and are stated in exactly one place.
 *
 * Contract published in `$SPRINT_COORDINATION_DIR/status/backend.md`.
 */

/**
 * Statuses a speaker may edit. REJECTED and WITHDRAWN are terminal: editing
 * them would silently rewrite the record the decision was made against, and
 * nothing downstream consumes the result. An admin reopens by changing status.
 */
export const EDITABLE_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "MAYBE",
  "ACCEPTED",
] as const satisfies readonly AbstractStatus[];

export type EditableStatus = (typeof EDITABLE_STATUSES)[number];

export function isEditableStatus(status: AbstractStatus): status is EditableStatus {
  return (EDITABLE_STATUSES as readonly AbstractStatus[]).includes(status);
}

/**
 * Statuses a speaker may withdraw from (W1). `ACCEPTED` is excluded on purpose:
 * once the programme team has accepted a talk it is theirs to remove, because a
 * confirmed `Session` may already be built and scheduled from it.
 */
export const WITHDRAWABLE_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "MAYBE",
] as const satisfies readonly AbstractStatus[];

/**
 * Self-withdrawal closes only review work that remains actionable. Completed
 * assignments and their scores remain part of the event's review history.
 */
export const WITHDRAWAL_OPEN_ASSIGNMENT_STATUSES = [
  "ASSIGNED",
  "IN_PROGRESS",
] as const satisfies readonly EvaluationAssignmentStatus[];

export type WithdrawRefusal = { code: string; message: string };

/**
 * Why a self-withdraw is refused, or null when it is allowed. `hasSession` is
 * belt-and-braces: only an ACCEPTED abstract can have been converted, so the
 * status rule already covers it, but a confirmed talk must never disappear from
 * the programme because of a portal click.
 */
export function withdrawRefusal(
  status: AbstractStatus,
  hasSession: boolean,
): WithdrawRefusal | null {
  if (!isEditableStatus(status)) {
    return {
      code: "ABSTRACT_LOCKED",
      message: lockReasonFor(status) ?? "This submission can no longer be changed.",
    };
  }
  if (status === "ACCEPTED" || hasSession) {
    return {
      code: "WITHDRAW_NOT_ALLOWED",
      message:
        "This talk has already been accepted for the programme, so it can't be withdrawn here. Contact the program team and they will take it off the schedule for you.",
    };
  }
  return null;
}

/**
 * Plain-language reason an abstract cannot be edited, or null when it can.
 * End users are non-technical event professionals, so this is user-facing copy,
 * not an error string.
 */
export function lockReasonFor(status: AbstractStatus): string | null {
  if (isEditableStatus(status)) return null;
  if (status === "REJECTED") {
    return "This proposal was not accepted for this event, so it can no longer be edited.";
  }
  return "This proposal was withdrawn, so it can no longer be edited. Contact the program team to reopen it.";
}

export type SpeakerEditRefusal = { code: string; message: string };

/** Stable refusal code for an edit attempted after the call for proposals closed. */
export const EDIT_WINDOW_CLOSED = "EDIT_WINDOW_CLOSED";

/**
 * CFP-16: once a form's `closesAt` has passed, a speaker may no longer change a
 * proposal the programme team has not accepted. The deadline is the rule the
 * whole review round is built on — an edit landing after reviewers started
 * reading changes the thing being judged.
 *
 * `ACCEPTED` is a deliberate, product-level carve-out and must stay: an accepted
 * speaker maintains their proposal record long after the CFP shut, which is the
 * normal case (the confirmed `Session` is separate — INV-DOMAIN-001).
 *
 * Self-withdrawal is deliberately NOT gated here. It is a status-only transition
 * with its own rules in `withdrawRefusal`, and refusing it after close would
 * trap a speaker in a proposal they no longer want to give.
 *
 * A form with no close date never closes, matching `validateSubmissionWindow`.
 */
export function closeDateEditRefusal(
  status: AbstractStatus,
  closesAt: Date | null,
  now: Date = new Date(),
): SpeakerEditRefusal | null {
  if (status === "ACCEPTED") return null;
  if (!closesAt || now < closesAt) return null;
  return {
    code: EDIT_WINDOW_CLOSED,
    message:
      "The call for proposals has closed, so this proposal can no longer be edited. Contact the program team if something still needs to change.",
  };
}

/**
 * Every reason a speaker cannot edit right now, in refusal order: a terminal
 * status first, then the closed call for proposals. One function so the API
 * refusal and the portal's read-only affordance can never disagree.
 */
export function speakerEditRefusal(
  status: AbstractStatus,
  closesAt: Date | null,
  now: Date = new Date(),
): SpeakerEditRefusal | null {
  const statusReason = lockReasonFor(status);
  if (statusReason) return { code: "ABSTRACT_LOCKED", message: statusReason };
  return closeDateEditRefusal(status, closesAt, now);
}

/**
 * Authorization (INV-EVENT-001): the caller must be listed as a speaker on the
 * abstract. Membership is resolved server-side from the signed session's
 * persisted user id — never from anything the client sends. Any co-speaker may
 * edit, not only the original submitter.
 */
export function isAbstractSpeaker(
  userId: string,
  speakers: readonly { userId: string }[],
): boolean {
  return speakers.some((speaker) => speaker.userId === userId);
}

/** A roster entry as it arrives from the client, already normalized by zod. */
export type SpeakerRosterEntry = { email: string; name: string; isPrimary: boolean };

/**
 * Has the roster changed? Compared by lowercased email set plus which email is
 * primary; name edits alone are not a roster change. Order is irrelevant.
 *
 * Used only to decide whether a locked roster (a converted abstract) is being
 * modified, so resending the current roster unchanged is always allowed.
 */
export function rosterChanged(
  current: readonly { email: string; isPrimary: boolean }[],
  next: readonly SpeakerRosterEntry[],
): boolean {
  const normalize = (entries: readonly { email: string; isPrimary: boolean }[]) => {
    const emails = entries.map((entry) => entry.email.trim().toLowerCase()).sort();
    const primary = entries
      .filter((entry) => entry.isPrimary)
      .map((entry) => entry.email.trim().toLowerCase())
      .sort();
    return JSON.stringify({ emails, primary });
  };
  return normalize(current) !== normalize(next);
}

/**
 * Merge a partial answer patch over stored answers, keyed by form field key.
 * Only supplied keys are written; required-field validation then runs against
 * the merged result, so patching one field never trips a required error on an
 * untouched one. An explicit `null` clears a stored answer.
 */
export function mergeAnswers(
  stored: Readonly<Record<string, FormAnswerValue>>,
  patch: Readonly<Record<string, FormAnswerValue>> | undefined,
  knownKeys: ReadonlySet<string>,
): Record<string, FormAnswerValue> {
  const merged: Record<string, FormAnswerValue> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (knownKeys.has(key)) merged[key] = value;
  }
  if (patch) {
    for (const [key, value] of Object.entries(patch)) {
      // Unknown keys are ignored, matching public submission behaviour.
      if (knownKeys.has(key)) merged[key] = value;
    }
  }
  return merged;
}

/**
 * PATCH body for `/api/cfp/submissions/{abstractId}`.
 *
 * Composed from the locked primitives in `types/api.ts` (not a copy of them) so
 * the field rules stay identical to public submission without editing the
 * Architect-owned contract file. Every key is optional: omitted means untouched,
 * explicit `null` clears a nullable field.
 */
export const speakerSubmissionPatchSchema = z
  .object({
    /**
     * The only status a speaker may set, and only on its own (W1). Every other
     * transition belongs to the programme team's decision endpoint.
     */
    status: z.literal("WITHDRAWN").optional(),
    title: z.string().trim().min(3).max(180).optional(),
    abstract: z.string().trim().max(5000).nullable().optional(),
    format: z.string().trim().max(80).nullable().optional(),
    durationMinutes: z.number().int().min(5).max(480).nullable().optional(),
    categoryId: idSchema.nullable().optional(),
    speakers: coSpeakerInputSchema.optional(),
    answers: z.record(z.string(), formAnswerValueSchema).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Provide at least one field to update.",
  })
  .refine((patch) => patch.status === undefined || Object.keys(patch).length === 1, {
    message: "Withdrawing must be sent on its own, without other changes.",
    path: ["status"],
  });

export type SpeakerSubmissionPatch = z.infer<typeof speakerSubmissionPatchSchema>;
