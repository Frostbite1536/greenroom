import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formConfigInputSchema } from "@/types/api";
import { requireContext, assertEventScope } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { serializeForm } from "@/lib/api/form-serialize";

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
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, formConfigInputSchema);
  assertEventScope(ctx, input.eventId);

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

  const form = await prisma.$transaction(async (tx) => {
    if (input.id) {
      const existing = await tx.formConfig.findUnique({ where: { id: input.id } });
      if (!existing || existing.eventId !== ctx.eventId) {
        throw new ApiError(404, "FORM_NOT_FOUND", "Form not found.");
      }
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

  return ok(serializeForm(form), input.id ? 200 : 201);
});
