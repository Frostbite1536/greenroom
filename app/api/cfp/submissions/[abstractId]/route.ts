import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireContext, type ApiContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import {
  answersByKey,
  serializeEditFormSpec,
  serializeSpeakerSubmission,
} from "@/lib/api/speaker-submission";
import {
  toFormFieldSpecs,
  validateSubmissionContent,
  type FormSpec,
} from "@/lib/services/form-validation";
import { lockAbstractForWrite } from "@/lib/services/abstract-lock";
import { OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import {
  closeDateEditRefusal,
  isAbstractSpeaker,
  isEditableStatus,
  lockReasonFor,
  mergeAnswers,
  rosterChanged,
  speakerSubmissionPatchSchema,
  WITHDRAWAL_OPEN_ASSIGNMENT_STATUSES,
  withdrawRefusal,
} from "@/lib/services/speaker-edit";
import type { FormAnswerValue } from "@/lib/services/types";
import { lockSpeakerContentWrite } from "@/lib/services/speaker-edit-lock";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ abstractId: string }> };

const submissionInclude = {
  category: true,
  speakers: { include: { user: true } },
  answers: true,
  formConfig: { include: { fields: true } },
  session: { select: { id: true, scheduleSlot: { select: { id: true } } } },
  // Review assignments/scores are intentionally never loaded here: a speaker
  // must not see their own review data.
} satisfies Prisma.AbstractInclude;

type LoadedSubmission = Prisma.AbstractGetPayload<{ include: typeof submissionInclude }>;

/**
 * Load an abstract the caller is a speaker on (R1 authorization).
 *
 * Order matters: existence and event scope first (404 — never confirm another
 * event's records), then the `AbstractSpeaker` link (403). Membership comes from
 * the server-resolved session user id, never from the request body.
 */
async function loadOwnSubmission(ctx: ApiContext, abstractId: string): Promise<LoadedSubmission> {
  const abstract = await prisma.abstract.findUnique({
    where: { id: abstractId },
    include: submissionInclude,
  });
  if (!abstract || abstract.eventId !== ctx.eventId) {
    throw new ApiError(404, "ABSTRACT_NOT_FOUND", "We couldn't find that submission.");
  }
  if (!isAbstractSpeaker(ctx.userId, abstract.speakers)) {
    throw new ApiError(
      403,
      "NOT_YOUR_SUBMISSION",
      "This submission belongs to someone else. You can only edit proposals you are speaking on.",
    );
  }
  return abstract;
}

/** The shared response body for both GET and PATCH, so the UI can re-render from either. */
async function submissionPayload(abstract: LoadedSubmission) {
  const categories = await prisma.category.findMany({
    where: { eventId: abstract.eventId },
    select: { id: true, name: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
    take: OPERATOR_QUERY_LIMITS.importCategories,
  });
  return {
    submission: serializeSpeakerSubmission(abstract),
    answersByKey: answersByKey(abstract.answers, abstract.formConfig.fields),
    form: serializeEditFormSpec(abstract.formConfig, categories),
  };
}

/** GET /api/cfp/submissions/:abstractId — one of the caller's own submissions (R1). */
export function GET(req: Request, ctx: Params) {
  return handle(async () => {
    const apiCtx = await requireContext();
    const { abstractId } = await ctx.params;
    const abstract = await loadOwnSubmission(apiCtx, abstractId);
    return ok(await submissionPayload(abstract));
  })(req);
}

/**
 * PATCH /api/cfp/submissions/:abstractId — a speaker edits their own submission
 * after it was submitted or accepted (R1, requirements delta 2026-08-08).
 *
 * Guarantees:
 * - Writes only `Abstract` scalars, `AbstractSpeaker`, and `FormAnswer`. The
 *   linked `Session` is never touched: conversion is 1:1 and the session is the
 *   confirmed record (INV-DOMAIN-001).
 * - `status`, `submittedAt`, and `decidedAt` are never changed by an edit.
 * - Content rules reuse the public submission validator verbatim
 *   (INV-FORM-001), minus its window gate. The edit window is enforced
 *   separately by `closeDateEditRefusal` (CFP-16): a non-accepted proposal is
 *   refused once `closesAt` passes, while accepted speakers keep editing after
 *   the CFP has closed. Publication and `opensAt` still gate new submissions
 *   only — an existing proposal is not un-editable because its form was
 *   unpublished.
 * - `{ "status": "WITHDRAWN" }` is the one status transition a speaker owns
 *   (W1). It must be sent on its own and is refused once the talk is accepted.
 */
export function PATCH(req: Request, ctx: Params) {
  return handle(async () => {
    const apiCtx = await requireContext();
    const { abstractId } = await ctx.params;
    const existing = await loadOwnSubmission(apiCtx, abstractId);
    const patch = await parseBody(req, speakerSubmissionPatchSchema);

    // W1: self-withdraw. Status-only, so it skips content validation entirely —
    // a speaker must be able to pull an incomplete proposal. Runs under the same
    // per-abstract advisory lock as decisions and conversion, so it cannot
    // interleave with an admin accepting the talk between check and write.
    if (patch.status === "WITHDRAWN") {
      const withdrawn = await prisma.$transaction(async (tx) => {
        await lockAbstractForWrite(tx, existing.id);
        const fresh = await tx.abstract.findUniqueOrThrow({
          where: { id: existing.id },
          select: {
            status: true,
            session: { select: { id: true } },
            speakers: { select: { userId: true } },
          },
        });
        if (!isAbstractSpeaker(apiCtx.userId, fresh.speakers)) {
          throw new ApiError(403, "NOT_YOUR_SUBMISSION", "You are not a speaker on this submission.");
        }
        // Authoritative re-check: the pre-lock decision above may be stale.
        const freshRefusal = withdrawRefusal(fresh.status, Boolean(fresh.session));
        if (freshRefusal) throw new ApiError(409, freshRefusal.code, freshRefusal.message);

        await tx.abstract.update({
          where: { id: existing.id },
          // Status only. `decidedAt` stays null: withdrawing is the speaker's
          // action, not a programme-team decision.
          data: { status: "WITHDRAWN" },
        });
        // The same Abstract advisory lock serializes score writes. Once the
        // proposal is withdrawn, only still-open review work is closed; a
        // completed review and its scores remain historical evidence.
        await tx.reviewAssignment.updateMany({
          where: {
            abstractId: existing.id,
            status: { in: [...WITHDRAWAL_OPEN_ASSIGNMENT_STATUSES] },
          },
          data: { status: "DECLINED" },
        });
        return tx.abstract.findUniqueOrThrow({
          where: { id: existing.id },
          include: submissionInclude,
        });
      });

      return ok(await submissionPayload(withdrawn));
    }

    const saved = await prisma.$transaction(async (tx) => {
      // LOCK-ORDER-v1: FormConfig, sorted current FormFields, then Abstract.
      // The earlier load supplies only immutable lock locators; every mutable
      // authority, form, session, roster, answer, and status fact is re-read
      // below after the final lock.
      const locks = await lockSpeakerContentWrite(tx, {
        formConfigId: existing.formConfigId,
        abstractId: existing.id,
      });
      if (!locks) {
        throw new ApiError(
          409,
          "FORM_CHANGED",
          "This form changed while your proposal was being saved. Review the latest questions and try again.",
        );
      }
      const fresh = await tx.abstract.findUnique({
        where: { id: existing.id },
        include: submissionInclude,
      });
      if (!fresh || fresh.eventId !== apiCtx.eventId) {
        throw new ApiError(404, "ABSTRACT_NOT_FOUND", "We couldn't find that submission.");
      }
      if (fresh.formConfigId !== locks.form.id || locks.form.eventId !== fresh.eventId) {
        throw new ApiError(
          409,
          "FORM_CHANGED",
          "This form changed while your proposal was being saved. Review the latest questions and try again.",
        );
      }
      // Re-verify membership after the final lock: a serialized earlier roster
      // edit may have removed this caller from the submission.
      if (!isAbstractSpeaker(apiCtx.userId, fresh.speakers)) {
        throw new ApiError(403, "NOT_YOUR_SUBMISSION", "You are not a speaker on this submission.");
      }
      if (!isEditableStatus(fresh.status)) {
        throw new ApiError(
          409,
          "ABSTRACT_LOCKED",
          lockReasonFor(fresh.status) ?? "This submission can no longer be edited.",
        );
      }
      // CFP-16, on the fresh post-lock read rather than the pre-lock load: the
      // close date lives on the `FormConfig` row this transaction already holds
      // FOR SHARE, so an admin cannot move `closesAt` between check and write,
      // and a status re-read cannot let a just-rejected proposal slip through.
      // ACCEPTED speakers are exempt on purpose (see `closeDateEditRefusal`).
      const closed = closeDateEditRefusal(fresh.status, locks.form.closesAt);
      if (closed) throw new ApiError(409, closed.code, closed.message);
      const rosterEdit =
        patch.speakers !== undefined &&
        rosterChanged(
          fresh.speakers.map((speaker) => ({ email: speaker.user.email, isPrimary: speaker.isPrimary })),
          patch.speakers,
        );
      if (rosterEdit && fresh.session) {
        throw new ApiError(
          409,
          "SPEAKERS_LOCKED",
          "This talk is already confirmed on the program, so the speaker list is fixed. Contact the program team to change speakers.",
        );
      }
      const primary = patch.speakers
        ? (patch.speakers.find((speaker) => speaker.isPrimary) ?? patch.speakers[0])
        : null;
      if (patch.speakers && !primary) {
        throw new ApiError(422, "NO_PRIMARY_SPEAKER", "A primary speaker is required.");
      }
      if (patch.categoryId) {
        const category = await tx.category.findUnique({ where: { id: patch.categoryId } });
        if (!category || category.eventId !== fresh.eventId) {
          throw new ApiError(422, "INVALID_CATEGORY", "Selected category is not valid for this event.");
        }
      }

      const knownKeys = new Set(locks.fields.map((field) => field.key));
      const stored = answersByKey(fresh.answers, locks.fields);
      const merged = mergeAnswers(stored, patch.answers as Record<string, FormAnswerValue>, knownKeys);

      // A DRAFT is incomplete by definition, so draft edits skip content rules
      // exactly like a public draft save does. Every submitted status validates
      // against the current FormConfig and field rows held above.
      if (fresh.status !== "DRAFT") {
        const spec: FormSpec = {
          published: locks.form.published,
          opensAt: locks.form.opensAt,
          closesAt: locks.form.closesAt,
          minSpeakers: locks.form.minSpeakers,
          maxSpeakers: locks.form.maxSpeakers,
          maxBioLength: locks.form.maxBioLength,
          fields: toFormFieldSpecs(locks.fields),
        };
        const error = validateSubmissionContent(spec, {
          speakerCount: patch.speakers ? patch.speakers.length : fresh.speakers.length,
          answers: merged,
          answerKeysToValidate: Object.keys(patch.answers ?? {}),
        });
        if (error) throw new ApiError(422, error.code, error.message, error.fieldErrors);
      }

      const fieldByKey = new Map(locks.fields.map((field) => [field.key, field]));

      // This writes the Abstract and nothing else. In particular, changing
      // `categoryId` on an ACCEPTED proposal does NOT propagate to the linked
      // `Session.categoryId`, and that is the invariant rather than an
      // oversight: per INV-EDIT-001 a speaker edit never silently mutates its
      // linked Session, because that Session is the public programme and this
      // caller is authorized as a speaker (`isAbstractSpeaker`), not as an
      // organizer. C18 owns the reconciliation handoff that surfaces the
      // divergence; until then an organizer repairs it by re-running
      // accept/convert, which reconciles the topic under ADMIN authority (see
      // `provisionSessionForAbstract`).
      await tx.abstract.update({
        where: { id: fresh.id },
        data: {
          // `status`, `submittedAt`, `decidedAt`, `submitterId`, and the form
          // link are deliberately absent: an edit never changes the record's
          // place in the pipeline or who submitted it.
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.abstract !== undefined ? { abstract: patch.abstract } : {}),
          ...(patch.format !== undefined ? { format: patch.format } : {}),
          ...(patch.durationMinutes !== undefined
            ? { durationMinutes: patch.durationMinutes }
            : {}),
          ...(patch.categoryId !== undefined ? { categoryId: patch.categoryId } : {}),
        },
      });

      if (patch.speakers && primary) {
        // Shell users may be created for a new co-speaker, but an existing
        // global identity is never overwritten (same rule as public submit).
        const speakerUsers = await Promise.all(
          patch.speakers.map((s) =>
            tx.user.upsert({
              where: { email: s.email },
              update: {},
              create: { email: s.email, name: s.name },
              select: { id: true },
            }),
          ),
        );
        const keepUserIds = speakerUsers.map((u) => u.id);
        await tx.abstractSpeaker.deleteMany({
          where: { abstractId: fresh.id, userId: { notIn: keepUserIds } },
        });
        for (let i = 0; i < patch.speakers.length; i++) {
          const isPrimary = patch.speakers[i] === primary;
          const role = patch.speakers[i].role;
          await tx.abstractSpeaker.upsert({
            where: { abstractId_userId: { abstractId: fresh.id, userId: speakerUsers[i].id } },
            update: { isPrimary, role },
            create: { abstractId: fresh.id, userId: speakerUsers[i].id, isPrimary, role },
          });
        }
      }

      // Only the keys actually supplied are written; unknown keys are ignored.
      for (const [key, value] of Object.entries(patch.answers ?? {})) {
        const field = fieldByKey.get(key);
        if (!field) continue;
        const stored =
          value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
        await tx.formAnswer.upsert({
          where: { abstractId_formFieldId: { abstractId: fresh.id, formFieldId: field.id } },
          update: { value: stored },
          create: { abstractId: fresh.id, formFieldId: field.id, value: stored },
        });
      }

      return tx.abstract.findUniqueOrThrow({
        where: { id: fresh.id },
        include: submissionInclude,
      });
    });

    return ok(await submissionPayload(saved));
  })(req);
}
