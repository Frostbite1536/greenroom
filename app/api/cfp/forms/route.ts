import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formConfigInputSchema } from "@/types/api";
import { requireContext, assertEventScope } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { serializeForm } from "@/lib/api/form-serialize";
import {
  answerOptionValues,
  describeDestructiveChange,
  findDestructiveFieldChanges,
  findDuplicateFieldKeys,
  findUsedRemovedOptions,
  hasAnswerValue,
} from "@/lib/services/form-config";
import { parseFieldOptions } from "@/lib/services/field-visibility";
import { lockFormFieldsForShapeWrite } from "@/lib/services/form-field-lock";

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

    // B5 (audit2#1): `FormAnswer` cascades from `FormField`, so the delete
    // below would silently destroy submitted answers. Refuse the destructive
    // shape changes first, but only where answers actually exist — an untouched
    // form stays freely editable.
    await assertAnswersNotDestroyed(tx, saved.id, input.fields);

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

  // Concurrent writes can race past the in-transaction checks onto a unique
  // index. Classify by the violated constraint: only the FormConfig slug index
  // is a SLUG_TAKEN contract error; a FormField key race is a concurrent-edit
  // conflict, not a slug problem.
  let form: Awaited<ReturnType<typeof runWrite>>;
  try {
    form = await runWrite();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const target = Array.isArray(error.meta?.target)
        ? (error.meta.target as string[]).join(",")
        : String(error.meta?.target ?? "");
      if (target.includes("slug")) {
        throw new ApiError(409, "SLUG_TAKEN", "Another form in this event already uses that URL.", {
          slug: ["This URL is already in use."],
        });
      }
      throw new ApiError(409, "CONCURRENT_EDIT", "This form was changed by another request. Reload and try again.");
    }
    throw error;
  }

  return ok(serializeForm(form), input.id ? 200 : 201);
});

const ANSWER_SCAN_PAGE_SIZE = 500;

/**
 * Refuse edits that would delete or invalidate answers people already gave
 * (WAVE1-B5 / audit2#1).
 *
 * Only fields that carry answers are protected, so building and reshaping a
 * form before anyone submits stays completely free. Label, help text, ordering,
 * required-ness and conditional logic remain editable at any time.
 */
async function assertAnswersNotDestroyed(
  tx: Prisma.TransactionClient,
  formConfigId: string,
  incoming: readonly { key: string; type: string; options?: { value: string }[] }[],
): Promise<void> {
  // Lock every existing field in a deterministic order before inspecting its
  // answers. A concurrent answer insert holds a conflicting FK key-share lock:
  // it either commits before this read (and is seen) or waits until this form
  // edit finishes. Concurrent form saves serialize on the same ordered rows.
  await lockFormFieldsForShapeWrite(tx, formConfigId);

  const stored = await tx.formField.findMany({
    where: { formConfigId },
    select: { id: true, key: true, label: true, type: true, options: true },
  });
  if (stored.length === 0) return;

  const changes = findDestructiveFieldChanges(
    stored.map((field) => ({
      key: field.key,
      type: field.type,
      options: parseFieldOptions(field.options),
    })),
    incoming,
  );
  if (changes.length === 0) return;

  const affected = new Map(stored.map((field) => [field.key, field]));
  const affectedIds = changes
    .map((change) => affected.get(change.key)?.id)
    .filter((id): id is string => Boolean(id));
  if (affectedIds.length === 0) return;

  const counts = await tx.formAnswer.groupBy({
    by: ["formFieldId"],
    where: { formFieldId: { in: affectedIds } },
    _count: { _all: true },
  });
  const answerCountByFieldId = new Map(
    counts.map((row) => [row.formFieldId, row._count._all]),
  );
  const removedByFieldId = new Map<string, ReadonlySet<string>>();
  for (const change of changes) {
    if (change.kind !== "optionsRemoved") continue;
    const field = affected.get(change.key);
    if (field && answerCountByFieldId.has(field.id)) {
      removedByFieldId.set(field.id, new Set(change.removed));
    }
  }
  const optionFieldIds = [...removedByFieldId.keys()];
  const usedRemoved = await findUsedRemovedOptions(
    removedByFieldId,
    (afterId, take) => tx.formAnswer.findMany({
      where: {
        formFieldId: { in: optionFieldIds },
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      orderBy: { id: "asc" },
      take,
      select: { id: true, formFieldId: true, value: true },
    }),
    ANSWER_SCAN_PAGE_SIZE,
  );

  // O3 task-form answers live in SpeakerTask.responses JSON rather than the
  // FormAnswer table. Scan every assignment linked to this form while the
  // field-shape lock is held; O3 answer writers take a conflicting key-share
  // lock, so this evidence cannot race with a response save.
  const affectedKeys = new Set(changes.map((change) => change.key));
  const removedByKey = new Map<string, Set<string>>();
  for (const change of changes) {
    if (change.kind === "optionsRemoved") removedByKey.set(change.key, new Set(change.removed));
  }
  const taskAnswerCountByKey = new Map<string, number>();
  const taskUsedRemovedByKey = new Map<string, Set<string>>();
  let afterTask: { taskId: string; userId: string } | null = null;

  while (true) {
    const page: Array<{ taskId: string; userId: string; responses: unknown }> = await tx.speakerTask.findMany({
      where: { task: { formConfigId } },
      orderBy: [{ taskId: "asc" }, { userId: "asc" }],
      ...(afterTask
        ? { cursor: { taskId_userId: afterTask }, skip: 1 }
        : {}),
      take: ANSWER_SCAN_PAGE_SIZE,
      select: { taskId: true, userId: true, responses: true },
    });

    for (const assignment of page) {
      if (!assignment.responses || typeof assignment.responses !== "object" || Array.isArray(assignment.responses)) continue;
      for (const [key, value] of Object.entries(assignment.responses)) {
        if (!affectedKeys.has(key) || !hasAnswerValue(value)) continue;
        taskAnswerCountByKey.set(key, (taskAnswerCountByKey.get(key) ?? 0) + 1);
        const candidates = removedByKey.get(key);
        if (!candidates) continue;
        const used = taskUsedRemovedByKey.get(key) ?? new Set<string>();
        for (const option of answerOptionValues(value)) {
          if (candidates.has(option)) used.add(option);
        }
        if (used.size > 0) taskUsedRemovedByKey.set(key, used);
      }
    }

    if (page.length < ANSWER_SCAN_PAGE_SIZE) break;
    const last: { taskId: string; userId: string; responses: unknown } | undefined = page[page.length - 1];
    const next: { taskId: string; userId: string } | null = last
      ? { taskId: last.taskId, userId: last.userId }
      : null;
    if (!next || (afterTask && next.taskId === afterTask.taskId && next.userId === afterTask.userId)) {
      throw new Error("Task-answer scan cursor did not advance.");
    }
    afterTask = next;
  }

  const fieldErrors: Record<string, string[]> = {};
  for (const change of changes) {
    const field = affected.get(change.key);
    if (!field) continue;
    const taskAnswerCount = taskAnswerCountByKey.get(change.key) ?? 0;
    const answerCount = (answerCountByFieldId.get(field.id) ?? 0) + taskAnswerCount;
    if (answerCount === 0) continue;

    if (change.kind === "optionsRemoved") {
      // Only refuse when a removed option was actually chosen by someone.
      const used = usedRemoved.get(field.id) ?? new Set<string>();
      const taskUsed = taskUsedRemovedByKey.get(change.key) ?? new Set<string>();
      const stillUsed = change.removed.filter((value) => used.has(value) || taskUsed.has(value));
      if (stillUsed.length === 0) continue;
      (fieldErrors[change.key] ??= []).push(
        describeDestructiveChange(
          { ...change, removed: stillUsed },
          field.label,
          answerCount,
          taskAnswerCount > 0 ? "saved response" : "submission",
        ),
      );
      continue;
    }

    (fieldErrors[change.key] ??= []).push(
      describeDestructiveChange(
        change,
        field.label,
        answerCount,
        taskAnswerCount > 0 ? "saved response" : "submission",
      ),
    );
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new ApiError(
      409,
      "FIELD_IN_USE",
      "Some questions have already been answered, so they can't be removed or changed that way.",
      fieldErrors,
    );
  }
}
