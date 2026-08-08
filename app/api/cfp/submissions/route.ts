import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { abstractStatusSchema, abstractUpsertSchema } from "@/types/api";
import { requireContext } from "@/lib/api/context";
import { ApiError, fail, handle, ok, parseBody } from "@/lib/api/http";
import { serializeAbstract } from "@/lib/api/abstract-serialize";
import { notifyAbstractSubmitted } from "@/lib/comms/notify-service";
import { validateSubmission, type FormSpec } from "@/lib/services/form-validation";
import type { FormAnswerValue } from "@/lib/services/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/cfp/submissions — list abstracts for the caller's event (admin).
 * Supports `?status=` (comma-separated) and `?formConfigId=` filters. Powers
 * the abstracts pipeline table and evaluation assignment picker.
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

  const abstracts = await prisma.abstract.findMany({
    where: {
      eventId: ctx.eventId,
      ...(statuses ? { status: { in: statuses } } : {}),
      ...(formConfigId ? { formConfigId } : {}),
    },
    include: {
      category: true,
      speakers: { include: { user: true } },
      answers: true,
      // Prisma fetches these relation sets for the whole result, rather than
      // issuing a query per serialized abstract.
      reviewAssignments: { select: { status: true } },
      reviewScores: { select: { score: true } },
    },
    orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }],
  });
  return ok(abstracts.map(serializeAbstract));
});

/**
 * POST /api/cfp/submissions — save a draft or submit an abstract from the
 * public CFP page (works with a null session). Co-speakers are keyed by email:
 * shell `User` rows are upserted by lowercased email, and the primary speaker
 * is the submitter (contract in STATE.md / types/api.ts). On `submit`, all
 * INV-FORM-001 constraints are enforced server-side.
 */
export const POST = handle(async (req) => {
  const input = await parseBody(req, abstractUpsertSchema);

  const form = await prisma.formConfig.findUnique({
    where: { id: input.formConfigId },
    include: { fields: true },
  });
  if (!form) throw new ApiError(404, "FORM_NOT_FOUND", "This form is not available.");

  const primary =
    input.speakers.find((s) => s.isPrimary) ?? input.speakers[0];
  if (!primary) {
    throw new ApiError(422, "NO_PRIMARY_SPEAKER", "A primary speaker is required.");
  }

  // Map incoming answer keys to known field ids; unknown keys are ignored.
  const fieldByKey = new Map(form.fields.map((f) => [f.key, f]));
  const answersByKey: Record<string, FormAnswerValue> = {};
  for (const [key, value] of Object.entries(input.answers)) {
    if (fieldByKey.has(key)) answersByKey[key] = value as FormAnswerValue;
  }

  if (input.intent === "submit") {
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
    const error = validateSubmission(spec, {
      speakerCount: input.speakers.length,
      answers: answersByKey,
    });
    if (error) return fail(422, error.code, error.message, error.fieldErrors);
  }

  if (input.categoryId) {
    const category = await prisma.category.findUnique({ where: { id: input.categoryId } });
    if (!category || category.eventId !== form.eventId) {
      throw new ApiError(422, "INVALID_CATEGORY", "Selected category is not valid for this event.");
    }
  }

  const saved = await prisma.$transaction(async (tx) => {
    // Public CFP input may create a shell user, but must never overwrite an
    // existing identity or grant an event membership/role.
    const speakerUsers = await Promise.all(
      input.speakers.map((s) =>
        tx.user.upsert({
          where: { email: s.email },
          update: {},
          create: { email: s.email, name: s.name },
          select: { id: true },
        }),
      ),
    );
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

  // O2 (Ops): tell the submitter, co-speakers and the program team. Never
  // throws and never blocks the response contract — a proposal must be saved
  // even if the mail provider is down. See lib/comms/notify-service.ts.
  if (input.intent === "submit") await notifyAbstractSubmitted(saved.id);

  return ok(serializeAbstract(saved), input.abstractId ? 200 : 201);
});
