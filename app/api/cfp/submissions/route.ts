import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { abstractStatusSchema, publicAbstractUpsertSchema } from "@/types/api";
import { requireContext } from "@/lib/api/context";
import { ApiError, fromZod, handle, ok } from "@/lib/api/http";
import {
  ADMIN_ABSTRACT_LIST_TAKE,
  adminAbstractListOrderBy,
  adminAbstractListWhere,
  toAdminAbstractListEnvelope,
} from "@/lib/api/admin-abstract-list";
import { parseBoundedJson } from "@/lib/api/bounded-json";
import { serializeAbstract } from "@/lib/api/abstract-serialize";
import { notifyAbstractSubmitted } from "@/lib/comms/notify-service";
import {
  toFormFieldSpecs,
  validateSubmission,
  validateSubmissionWindow,
  type FormSpec,
} from "@/lib/services/form-validation";
import type { FormAnswerValue } from "@/lib/services/types";
import { lockCurrentFormFieldsForAnswerWrite } from "@/lib/services/form-field-lock";
import { lockFormConfigForAnswerWrite } from "@/lib/services/form-config-lock";
import { lockPublicSubmissionIdentities } from "@/lib/services/public-submission";
import { enforcePublicSubmissionRateLimit, publicClientIp } from "@/lib/services/public-submission-rate";

export const dynamic = "force-dynamic";

/**
 * GET /api/cfp/submissions — bounded list for the caller's event (admin or
 * evaluator). Supports `?status=` (comma-separated) and `?formConfigId=`.
 * The explicit envelope prevents a large event from silently exhausting an
 * operator read while preserving an honest filtered total for the UI.
 */
export const GET = handle(async (req) => {
  const ctx = await requireContext(["ADMIN", "EVALUATOR"]);
  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const formConfigId = url.searchParams.get("formConfigId") ?? undefined;

  const statuses = statusParam
    ? statusParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => abstractStatusSchema.parse(s))
    : undefined;

  const where = adminAbstractListWhere({ eventId: ctx.eventId, statuses, formConfigId });
  const [abstracts, total] = await prisma.$transaction(
    [
      prisma.abstract.findMany({
        where,
        // Every included relation is bounded by this cap-plus-one parent query;
        // no unbounded event-wide relation fetch is possible through this route.
        take: ADMIN_ABSTRACT_LIST_TAKE,
        include: {
          category: true,
          speakers: { include: { user: true } },
          answers: true,
          reviewAssignments: { select: { status: true } },
          reviewScores: { select: { score: true } },
        },
        orderBy: adminAbstractListOrderBy,
      }),
      prisma.abstract.count({ where }),
    ],
    // Rows and the filtered total must observe one PostgreSQL snapshot.
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  return ok(toAdminAbstractListEnvelope(abstracts.map(serializeAbstract), total));
});

/**
 * POST /api/cfp/submissions — save a draft or submit an abstract from the
 * public CFP page (works with a null session). Both drafts and submits require
 * a published, open form; anonymous rows must not accumulate after a CFP has
 * closed. Co-speakers are keyed by email:
 * shell `User` rows are upserted by lowercased email, and the primary speaker
 * is the submitter (contract in STATE.md / types/api.ts). On `submit`, all
 * INV-FORM-001 constraints are enforced server-side.
 */
export const POST = handle(async (req) => {
  const parsed = publicAbstractUpsertSchema.safeParse(await parseBoundedJson(req));
  if (!parsed.success) throw fromZod(parsed.error);
  const input = parsed.data;

  // This minimal known-form pre-read establishes event scope for the independent
  // rate transaction. Eligibility is authoritative only after the business
  // transaction obtains its FormConfig parent lock below.
  const preReadForm = await prisma.formConfig.findUnique({
    where: { id: input.formConfigId },
    select: { id: true, eventId: true, published: true, opensAt: true, closesAt: true },
  });
  if (!preReadForm) throw new ApiError(404, "FORM_NOT_FOUND", "This form is not available.");

  const primary =
    input.speakers.find((s) => s.isPrimary) ?? input.speakers[0];
  if (!primary) {
    throw new ApiError(422, "NO_PRIMARY_SPEAKER", "A primary speaker is required.");
  }

  // Known-form attempts consume a rate token before later content/category
  // validation. This transaction finishes before the business writer starts.
  await enforcePublicSubmissionRateLimit({
    eventId: preReadForm.eventId,
    intent: input.intent,
    primaryEmail: primary.email,
    clientIp: publicClientIp(req.headers),
  });

  const saved = await prisma.$transaction(async (tx) => {
    // LOCK-ORDER-v1: FormConfig parent, sorted FormFields, sorted identities.
    // No Abstract lock is added here pending the coordinated inversion work.
    const form = await lockFormConfigForAnswerWrite(tx, input.formConfigId);
    if (!form) throw new ApiError(404, "FORM_NOT_FOUND", "This form is not available.");
    const fields = await lockCurrentFormFieldsForAnswerWrite(tx, form.id);
    const spec: FormSpec = {
      published: form.published,
      opensAt: form.opensAt,
      closesAt: form.closesAt,
      minSpeakers: form.minSpeakers,
      maxSpeakers: form.maxSpeakers,
      maxBioLength: form.maxBioLength,
      fields: toFormFieldSpecs(fields),
    };
    const windowError = validateSubmissionWindow(spec);
    if (windowError) throw new ApiError(422, windowError.code, windowError.message, windowError.fieldErrors);

    // Map incoming answer keys to known locked field ids; unknown keys remain
    // intentionally ignored, matching the public renderer's forward-safe form.
    const fieldByKey = new Map(fields.map((field) => [field.key, field]));
    const answersByKey: Record<string, FormAnswerValue> = {};
    for (const [key, value] of Object.entries(input.answers)) {
      if (fieldByKey.has(key)) answersByKey[key] = value as FormAnswerValue;
    }

    if (input.intent === "submit") {
      const error = validateSubmission(spec, {
        speakerCount: input.speakers.length,
        answers: answersByKey,
      });
      if (error) throw new ApiError(422, error.code, error.message, error.fieldErrors);
    }

    if (input.categoryId) {
      const category = await tx.category.findUnique({ where: { id: input.categoryId } });
      if (!category || category.eventId !== form.eventId) {
        throw new ApiError(422, "INVALID_CATEGORY", "Selected category is not valid for this event.");
      }
    }

    await lockPublicSubmissionIdentities(tx, input.speakers.map((speaker) => speaker.email));

    // Public CFP input may create a shell user, but must never overwrite an
    // existing identity or grant an event membership/role.
    const usersByEmail = new Map<string, { id: string }>();
    for (const speaker of [...input.speakers].sort((left, right) => left.email.localeCompare(right.email))) {
      if (!usersByEmail.has(speaker.email)) {
        const user = await tx.user.upsert({
          where: { email: speaker.email },
          update: {},
          create: { email: speaker.email, name: speaker.name },
          select: { id: true },
        });
        usersByEmail.set(speaker.email, user);
      }
    }
    const speakerUsers = input.speakers.map((speaker) => usersByEmail.get(speaker.email)!);
    const primaryUser = speakerUsers[input.speakers.indexOf(primary)];

    if (input.abstractId) {
      const existing = await tx.abstract.findUnique({ where: { id: input.abstractId } });
      if (!existing || existing.formConfigId !== form.id) {
        throw new ApiError(404, "ABSTRACT_NOT_FOUND", "Draft not found.");
      }
      if (existing.status !== "DRAFT") {
        throw new ApiError(409, "ABSTRACT_LOCKED", "This abstract can no longer be edited.");
      }
    }

    const isSubmit = input.intent === "submit";

    // Enforce submission limit per submitter for this form (submitted only).
    if (isSubmit && form.submissionLimit) {
      const count = await tx.abstract.count({
        where: {
          formConfigId: form.id,
          submitterId: primaryUser.id,
          status: { not: "DRAFT" },
          ...(input.abstractId ? { id: { not: input.abstractId } } : {}),
        },
      });
      if (count >= form.submissionLimit) {
        throw new ApiError(
          409,
          "SUBMISSION_LIMIT",
          `You can submit at most ${form.submissionLimit} proposal(s) to this form.`,
        );
      }
    }

    const abstractData = {
      title: input.title,
      abstract: input.abstract ?? null,
      format: input.format ?? null,
      durationMinutes: input.durationMinutes ?? null,
      categoryId: input.categoryId ?? null,
      status: isSubmit ? ("SUBMITTED" as const) : ("DRAFT" as const),
      submittedAt: isSubmit ? new Date() : null,
    };

    const abstract = input.abstractId
      ? await tx.abstract.update({ where: { id: input.abstractId }, data: abstractData })
      : await tx.abstract.create({
          data: {
            eventId: form.eventId,
            formConfigId: form.id,
            submitterId: primaryUser.id,
            ...abstractData,
          },
        });

    // Reconcile speakers.
    const keepUserIds = speakerUsers.map((u) => u.id);
    await tx.abstractSpeaker.deleteMany({
      where: { abstractId: abstract.id, userId: { notIn: keepUserIds } },
    });
    for (let i = 0; i < input.speakers.length; i++) {
      const userId = speakerUsers[i].id;
      const isPrimary = input.speakers[i] === primary;
      await tx.abstractSpeaker.upsert({
        where: { abstractId_userId: { abstractId: abstract.id, userId } },
        update: { isPrimary },
        create: { abstractId: abstract.id, userId, isPrimary },
      });
    }

    // Reconcile answers to known fields.
    for (const [key, value] of Object.entries(answersByKey)) {
      const field = fieldByKey.get(key);
      if (!field) continue;
      await tx.formAnswer.upsert({
        where: { abstractId_formFieldId: { abstractId: abstract.id, formFieldId: field.id } },
        update: { value: value as Prisma.InputJsonValue },
        create: {
          abstractId: abstract.id,
          formFieldId: field.id,
          value: value as Prisma.InputJsonValue,
        },
      });
    }

    return tx.abstract.findUniqueOrThrow({
      where: { id: abstract.id },
      include: { category: true, speakers: { include: { user: true } }, answers: true },
    });
  });

  // A submitted public roster receives exactly one receipt at its persisted
  // Abstract.submitter (the primary roster entry). Delivery never blocks save.
  if (input.intent === "submit") await notifyAbstractSubmitted(saved.id);

  return ok(serializeAbstract(saved), input.abstractId ? 200 : 201);
});
