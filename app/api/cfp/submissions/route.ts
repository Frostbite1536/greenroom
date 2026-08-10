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
import { serializeAbstract, serializeAdminAbstract } from "@/lib/api/abstract-serialize";
import { getAdminDecisionSummary } from "@/lib/services/admin-decision-summary";
import { notifyAbstractSubmitted } from "@/lib/comms/notify-service";
import {
  toFormFieldSpecs,
  validateSubmission,
  validateSubmissionWindow,
  type FormSpec,
} from "@/lib/services/form-validation";
import type { FormAnswerValue } from "@/lib/services/types";
import { lockPublicDraftWrite } from "@/lib/services/public-draft-write-lock";
import { enforcePublicSubmissionRateLimit, publicClientIp } from "@/lib/services/public-submission-rate";
import {
  generateDraftCapability,
  hashDraftCapability,
  verifyDraftWriteAccess,
} from "@/lib/services/draft-capability";
import { getServerSigningSecret } from "@/lib/server-signing";

export const dynamic = "force-dynamic";

const DRAFT_NOT_FOUND = "DRAFT_NOT_FOUND";
const DRAFT_NOT_FOUND_MESSAGE = "Draft not found.";

function draftNotFound(): ApiError {
  return new ApiError(404, DRAFT_NOT_FOUND, DRAFT_NOT_FOUND_MESSAGE);
}

function requireDraftCapabilitySecret(): string {
  const secret = getServerSigningSecret();
  if (!secret) {
    throw new ApiError(503, "DRAFT_CAPABILITY_UNAVAILABLE", "Draft recovery is temporarily unavailable.");
  }
  return secret;
}

function publicDraftResponse(
  abstract: Parameters<typeof serializeAbstract>[0] & { draftRevision: number },
  draftCapability?: string,
) {
  return {
    ...serializeAbstract(abstract),
    ...(abstract.status === "DRAFT" ? { draftRevision: abstract.draftRevision } : {}),
    ...(draftCapability ? { draftCapability } : {}),
  };
}

/**
 * GET /api/cfp/submissions — bounded list for the caller's event (admin only).
 * Supports `?status=` (comma-separated), `?formConfigId=`, and explicit
 * `?planId=` decision-summary selection.
 */
export const GET = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const formConfigId = url.searchParams.get("formConfigId") ?? undefined;
  const planId = url.searchParams.get("planId") ?? undefined;

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
        take: ADMIN_ABSTRACT_LIST_TAKE,
        include: { category: true, speakers: { include: { user: true } }, answers: true },
        orderBy: adminAbstractListOrderBy,
      }),
      prisma.abstract.count({ where }),
    ],
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  const page = toAdminAbstractListEnvelope(abstracts.map(serializeAdminAbstract), total);
  const decisionSummary = await getAdminDecisionSummary(ctx, {
    abstractIds: page.abstracts.map((abstract) => abstract.id),
    planId,
  });
  return ok({ ...page, decisionSummary });
});

/**
 * POST /api/cfp/submissions — anonymous draft save or submit. Existing draft
 * writes use the one-time capability only after every preceding LOCK-ORDER-v1
 * class is acquired; rate limiting remains a separate short transaction.
 */
export const POST = handle(async (req) => {
  const parsed = publicAbstractUpsertSchema.safeParse(await parseBoundedJson(req));
  if (!parsed.success) throw fromZod(parsed.error);
  const input = parsed.data;

  const preReadForm = await prisma.formConfig.findUnique({
    where: { id: input.formConfigId },
    select: { id: true, eventId: true, published: true, opensAt: true, closesAt: true },
  });
  if (!preReadForm) throw new ApiError(404, "FORM_NOT_FOUND", "This form is not available.");

  const primary = input.speakers.find((speaker) => speaker.isPrimary) ?? input.speakers[0];
  if (!primary) throw new ApiError(422, "NO_PRIMARY_SPEAKER", "A primary speaker is required.");

  await enforcePublicSubmissionRateLimit({
    eventId: preReadForm.eventId,
    intent: input.intent,
    primaryEmail: primary.email,
    clientIp: publicClientIp(req.headers),
  });

  // Only a new draft needs a raw capability. It is kept in request-local memory
  // until the response and is never loaded from, or written to, a serializer.
  const createdDraftCapability = !input.abstractId && input.intent === "saveDraft"
    ? generateDraftCapability()
    : null;
  const capabilitySecret = (input.abstractId || createdDraftCapability)
    ? requireDraftCapabilitySecret()
    : null;

  const saved = await prisma.$transaction(async (tx) => {
    const locks = await lockPublicDraftWrite(tx, {
      formConfigId: input.formConfigId,
      speakerEmails: input.speakers.map((speaker) => speaker.email),
      abstractId: input.abstractId,
    });
    if (!locks) throw new ApiError(404, "FORM_NOT_FOUND", "This form is not available.");

    // Existing writes reach this point only after FormConfig, sorted fields,
    // sorted identity keys, and the target Abstract advisory lock. Re-read all
    // mutable authority facts before validation, User upsert, or persistence.
    const existing = input.abstractId
      ? await tx.abstract.findUnique({
          where: { id: input.abstractId },
          include: { answers: true },
        })
      : null;
    if (input.abstractId) {
      if (
        !existing ||
        existing.formConfigId !== locks.form.id ||
        existing.eventId !== locks.form.eventId ||
        existing.status !== "DRAFT" ||
        !capabilitySecret
      ) {
        throw draftNotFound();
      }
      const access = verifyDraftWriteAccess({
        storedHash: existing.draftCapabilityHash,
        capability: input.draftCapability,
        secret: capabilitySecret,
        draftRevision: existing.draftRevision,
        expectedDraftRevision: input.expectedDraftRevision,
      });
      if (access === "not_found") throw draftNotFound();
      if (access === "conflict") {
        throw new ApiError(409, "DRAFT_CONFLICT", "This draft changed in another tab. Reload it before saving again.");
      }
    }

    const spec: FormSpec = {
      published: locks.form.published,
      opensAt: locks.form.opensAt,
      closesAt: locks.form.closesAt,
      minSpeakers: locks.form.minSpeakers,
      maxSpeakers: locks.form.maxSpeakers,
      maxBioLength: locks.form.maxBioLength,
      fields: toFormFieldSpecs(locks.fields),
    };
    const windowError = validateSubmissionWindow(spec);
    if (windowError) throw new ApiError(422, windowError.code, windowError.message, windowError.fieldErrors);

    const fieldByKey = new Map(locks.fields.map((field) => [field.key, field]));
    const fieldById = new Map(locks.fields.map((field) => [field.id, field]));
    const suppliedAnswersByKey: Record<string, FormAnswerValue> = {};
    for (const [key, value] of Object.entries(input.answers)) {
      if (fieldByKey.has(key)) suppliedAnswersByKey[key] = value as FormAnswerValue;
    }
    const storedAnswersByKey: Record<string, FormAnswerValue> = {};
    for (const answer of existing?.answers ?? []) {
      const field = fieldById.get(answer.formFieldId);
      if (field) storedAnswersByKey[field.key] = answer.value as FormAnswerValue;
    }
    const mergedAnswersByKey = { ...storedAnswersByKey, ...suppliedAnswersByKey };

    if (input.intent === "submit") {
      const error = validateSubmission(spec, {
        speakerCount: input.speakers.length,
        answers: mergedAnswersByKey,
      });
      if (error) throw new ApiError(422, error.code, error.message, error.fieldErrors);
    }

    if (input.categoryId) {
      const category = await tx.category.findUnique({ where: { id: input.categoryId } });
      if (!category || category.eventId !== locks.form.eventId) {
        throw new ApiError(422, "INVALID_CATEGORY", "Selected category is not valid for this event.");
      }
    }

    // Capability/revision/form status now hold under the Abstract lock; only
    // after that proof may untrusted input create Users or mutate the roster.
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
    const isSubmit = input.intent === "submit";

    if (isSubmit && locks.form.submissionLimit) {
      const count = await tx.abstract.count({
        where: {
          formConfigId: locks.form.id,
          submitterId: primaryUser.id,
          status: { not: "DRAFT" },
          ...(existing ? { id: { not: existing.id } } : {}),
        },
      });
      if (count >= locks.form.submissionLimit) {
        throw new ApiError(
          409,
          "SUBMISSION_LIMIT",
          `You can submit at most ${locks.form.submissionLimit} proposal(s) to this form.`,
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
    const abstract = existing
      ? await tx.abstract.update({
          where: { id: existing.id },
          data: {
            ...abstractData,
            draftRevision: { increment: 1 },
            ...(isSubmit ? { draftCapabilityHash: null } : {}),
          },
        })
      : await tx.abstract.create({
          data: {
            eventId: locks.form.eventId,
            formConfigId: locks.form.id,
            submitterId: primaryUser.id,
            ...abstractData,
            draftRevision: createdDraftCapability ? 1 : 0,
            draftCapabilityHash: createdDraftCapability
              ? hashDraftCapability(createdDraftCapability, capabilitySecret!)
              : null,
          },
        });

    const keepUserIds = speakerUsers.map((user) => user.id);
    await tx.abstractSpeaker.deleteMany({
      where: { abstractId: abstract.id, userId: { notIn: keepUserIds } },
    });
    for (let index = 0; index < input.speakers.length; index++) {
      const userId = speakerUsers[index].id;
      const isPrimary = input.speakers[index] === primary;
      // The role is per-proposal and always written from the submitted roster,
      // so clearing the box on a resubmitted draft really does clear the label.
      const role = input.speakers[index].role;
      await tx.abstractSpeaker.upsert({
        where: { abstractId_userId: { abstractId: abstract.id, userId } },
        update: { isPrimary, role },
        create: { abstractId: abstract.id, userId, isPrimary, role },
      });
    }

    for (const [key, value] of Object.entries(suppliedAnswersByKey)) {
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

    return {
      abstract: await tx.abstract.findUniqueOrThrow({
        where: { id: abstract.id },
        include: { category: true, speakers: { include: { user: true } }, answers: true },
      }),
      transitionedToSubmitted: isSubmit,
    };
  });

  if (saved.transitionedToSubmitted) await notifyAbstractSubmitted(saved.abstract.id);
  return ok(
    publicDraftResponse(saved.abstract, createdDraftCapability ?? undefined),
    input.abstractId ? 200 : 201,
  );
});
