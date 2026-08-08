import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formConfigInputSchema } from "@/types/api";
import { requireContext, assertEventScope } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { serializeForm } from "@/lib/api/form-serialize";
import { findDuplicateFieldKeys } from "@/lib/services/form-config";

export const dynamic = "force-dynamic";

/** GET /api/cfp/forms — list CFP forms for the caller's event (admin). */
export const GET = handle(async () => {
  const ctx = await requireContext(["ADMIN"]);
  const forms = await prisma.formConfig.findMany({
    where: { eventId: ctx.eventId },
    include: { fields: true, _count: { select: { abstracts: true } } },
    orderBy: { createdAt: "desc" },
  });
  return ok(
    forms.map((form) => ({
      ...serializeForm(form),
      abstractCount: form._count.abstracts,
    })),
  );
});

/**
 * POST /api/cfp/forms — create or update a form config with its fields (admin).
 * Fields are reconciled to match the payload: upsert incoming, delete removed.
 *
 * Omitting `id` creates a new form. Slugs are unique per event and the public
 * `/cfp/:formId` route accepts an id or a slug, so both collisions are refused
 * here with `SLUG_TAKEN` rather than surfacing as an unhandled write error.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, formConfigInputSchema);
  assertEventScope(ctx, input.eventId);

  // Reconciliation upserts by key, so duplicates would silently collapse into
  // one field and drop the operator's edit. Refuse at the boundary instead.
  const duplicateKeys = findDuplicateFieldKeys(input.fields);
  if (duplicateKeys.length > 0) {
    throw new ApiError(422, "VALIDATION_ERROR", "Request validation failed.", {
      fields: duplicateKeys.map((key) => `Duplicate field key: ${key}`),
    });
  }

  const data = {
    name: input.name,
    slug: input.slug,
    welcomeText: input.welcomeText ?? null,
    thankYouText: input.thankYouText ?? null,
    opensAt: input.opensAt ? new Date(input.opensAt) : null,
    closesAt: input.closesAt ? new Date(input.closesAt) : null,
    submissionLimit: input.submissionLimit ?? null,
    minSpeakers: input.minSpeakers,
    maxSpeakers: input.maxSpeakers,
    maxBioLength: input.maxBioLength,
    published: input.published,
  } satisfies Prisma.FormConfigUncheckedUpdateInput;

  const runWrite = () => prisma.$transaction(async (tx) => {
    if (input.id) {
      const existing = await tx.formConfig.findUnique({ where: { id: input.id } });
      if (!existing || existing.eventId !== ctx.eventId) {
        throw new ApiError(404, "FORM_NOT_FOUND", "Form not found.");
      }
    }

    const slugTaken = await tx.formConfig.findFirst({
      where: {
        eventId: ctx.eventId,
        slug: input.slug,
        ...(input.id ? { id: { not: input.id } } : {}),
      },
      select: { id: true },
    });
    if (slugTaken) {
      throw new ApiError(409, "SLUG_TAKEN", "Another form in this event already uses that URL.", {
        slug: ["This URL is already in use."],
      });
    }

    // A slug equal to some other form's id would shadow that form's public
    // id-based URL (INV-FORM-001: public resolution must be unambiguous).
    const shadowsFormId = await tx.formConfig.findFirst({
      where: { id: input.slug, ...(input.id ? { NOT: { id: input.id } } : {}) },
      select: { id: true },
    });
    if (shadowsFormId) {
      throw new ApiError(409, "SLUG_TAKEN", "That URL is reserved by another form.", {
        slug: ["This URL is already in use."],
      });
    }

    const saved = await tx.formConfig.upsert({
      where: { id: input.id ?? "__new__" },
      update: data,
      create: { eventId: input.eventId, ...data },
    });

    const keepKeys = new Set(input.fields.map((f) => f.key));
    await tx.formField.deleteMany({
      where: { formConfigId: saved.id, key: { notIn: [...keepKeys] } },
    });

    for (const field of input.fields) {
      const fieldData = {
        label: field.label,
        helpText: field.helpText ?? null,
        type: field.type,
        required: field.required,
        options: (field.options ?? null) as Prisma.InputJsonValue,
        conditionalLogic: (field.conditionalLogic ?? null) as Prisma.InputJsonValue,
        sortOrder: field.sortOrder,
      };
      await tx.formField.upsert({
        where: { formConfigId_key: { formConfigId: saved.id, key: field.key } },
        update: fieldData,
        create: { formConfigId: saved.id, key: field.key, ...fieldData },
      });
    }

    return tx.formConfig.findUniqueOrThrow({
      where: { id: saved.id },
      include: { fields: true },
    });
  });

  // Two admins creating the same slug concurrently both pass the in-transaction
  // check and race on the unique index; report that as the same contract error.
  let form: Awaited<ReturnType<typeof runWrite>>;
  try {
    form = await runWrite();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ApiError(409, "SLUG_TAKEN", "Another form in this event already uses that URL.", {
        slug: ["This URL is already in use."],
      });
    }
    throw error;
  }

  return ok(serializeForm(form), input.id ? 200 : 201);
});
