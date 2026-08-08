import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireContext, type ApiContext } from "@/lib/api/context";
import { ApiError, fail, handle, ok, parseBody } from "@/lib/api/http";
import {
  answersByKey,
  serializeEditFormSpec,
  serializeSpeakerSubmission,
} from "@/lib/api/speaker-submission";
import { validateSubmissionContent, type FormSpec } from "@/lib/services/form-validation";
import { lockAbstractForWrite } from "@/lib/services/abstract-lock";
import { OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import {
  isAbstractSpeaker,
  isEditableStatus,
  lockReasonFor,
  mergeAnswers,
  rosterChanged,
  speakerSubmissionPatchSchema,
} from "@/lib/services/speaker-edit";
import type { FormAnswerValue } from "@/lib/services/types";

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
 *   (INV-FORM-001), minus the window gate — edit-lock windows are explicitly
 *   not used, and accepted speakers edit after the CFP has closed.
 */
export function PATCH(req: Request, ctx: Params) {
  return handle(async () => {
    const apiCtx = await requireContext();
    const { abstractId } = await ctx.params;
    const existing = await loadOwnSubmission(apiCtx, abstractId);

    if (!isEditableStatus(existing.status)) {
      throw new ApiError(
        409,
        "ABSTRACT_LOCKED",
        lockReasonFor(existing.status) ?? "This submission can no longer be edited.",
      );
    }

    const patch = await parseBody(req, speakerSubmissionPatchSchema);
    const form = existing.formConfig;

    // A converted abstract's roster was copied onto the confirmed Session, so
    // changing it here would leave the two records disagreeing. This pre-check
    // gives a fast, friendly failure; the authoritative re-check runs inside
    // the locked transaction below.
    const rosterEdit =
      patch.speakers !== undefined &&
      rosterChanged(
        existing.speakers.map((s) => ({ email: s.user.email, isPrimary: s.isPrimary })),
        patch.speakers,
      );
    if (rosterEdit && existing.session) {
      throw new ApiError(
        409,
        "SPEAKERS_LOCKED",
        "This talk is already confirmed on the programme, so the speaker list is fixed. Contact the program team to change speakers.",
      );
    }

    const primary = patch.speakers
      ? (patch.speakers.find((s) => s.isPrimary) ?? patch.speakers[0])
      : null;
    if (patch.speakers && !primary) {
      throw new ApiError(422, "NO_PRIMARY_SPEAKER", "A primary speaker is required.");
    }

    if (patch.categoryId) {
      const category = await prisma.category.findUnique({ where: { id: patch.categoryId } });
      if (!category || category.eventId !== existing.eventId) {
        throw new ApiError(422, "INVALID_CATEGORY", "Selected category is not valid for this event.");
      }
    }

    const knownKeys = new Set(form.fields.map((f) => f.key));
    const stored = answersByKey(existing.answers, form.fields);
    const merged = mergeAnswers(stored, patch.answers as Record<string, FormAnswerValue>, knownKeys);

    // A DRAFT is incomplete by definition, so draft edits skip content rules
    // exactly like a public draft save does. Everything already submitted must
    // stay valid against the form it was submitted to.
    if (existing.status !== "DRAFT") {
      const spec: FormSpec = {
        published: form.published,
        opensAt: form.opensAt,
        closesAt: form.closesAt,
        minSpeakers: form.minSpeakers,
        maxSpeakers: form.maxSpeakers,
        maxBioLength: form.maxBioLength,
        fields: form.fields.map((f) => ({
          key: f.key,
          label: f.label,
          type: f.type,
          required: f.required,
        })),
      };
      const error = validateSubmissionContent(spec, {
        speakerCount: patch.speakers ? patch.speakers.length : existing.speakers.length,
        answers: merged,
      });
      if (error) return fail(422, error.code, error.message, error.fieldErrors);
    }

    const fieldByKey = new Map(form.fields.map((f) => [f.key, f]));

    const saved = await prisma.$transaction(async (tx) => {
      // Serialize against concurrent decisions and conversion, then re-read the
      // row: the pre-transaction status/session checks could otherwise go
      // stale between read and write (e.g. an admin rejects or converts this
      // abstract mid-request) and commit an edit against a terminal record.
      await lockAbstractForWrite(tx, existing.id);
      const fresh = await tx.abstract.findUniqueOrThrow({
        where: { id: existing.id },
        select: { status: true, session: { select: { id: true } } },
      });
      if (!isEditableStatus(fresh.status)) {
        throw new ApiError(
          409,
          "ABSTRACT_LOCKED",
          lockReasonFor(fresh.status) ?? "This submission can no longer be edited.",
        );
      }
      if (rosterEdit && fresh.session) {
        throw new ApiError(
          409,
          "SPEAKERS_LOCKED",
          "This talk is already confirmed on the programme, so the speaker list is fixed. Contact the program team to change speakers.",
        );
      }

      await tx.abstract.update({
        where: { id: existing.id },
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
          where: { abstractId: existing.id, userId: { notIn: keepUserIds } },
        });
        for (let i = 0; i < patch.speakers.length; i++) {
          const isPrimary = patch.speakers[i] === primary;
          await tx.abstractSpeaker.upsert({
            where: { abstractId_userId: { abstractId: existing.id, userId: speakerUsers[i].id } },
            update: { isPrimary },
            create: { abstractId: existing.id, userId: speakerUsers[i].id, isPrimary },
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
          where: { abstractId_formFieldId: { abstractId: existing.id, formFieldId: field.id } },
          update: { value: stored },
          create: { abstractId: existing.id, formFieldId: field.id, value: stored },
        });
      }

      return tx.abstract.findUniqueOrThrow({
        where: { id: existing.id },
        include: submissionInclude,
      });
    });

    return ok(await submissionPayload(saved));
  })(req);
}
