import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { importRequestSchema } from "@/types/api";
import { assertEventScope, requireContext } from "@/lib/api/context";
import { ApiError, fail, handle, ok, parseBody } from "@/lib/api/http";
import {
  CsvImportError,
  csvAbstractImportIdentityKey,
  coerceCsvAnswer,
  mapCsvRows,
  parseCsv,
  validateImportedAnswers,
  validateAbstractMappings,
} from "@/lib/integrations/csv-import";
import { validateSubmission } from "@/lib/services/form-validation";
import type { FormAnswerValue } from "@/lib/services/types";

export const dynamic = "force-dynamic";

type PreparedAbstract = {
  rowNumber: number;
  formConfigId: string;
  title: string;
  abstract: string | null;
  format: string | null;
  durationMinutes: number | null;
  speakerEmail: string;
  speakerName: string;
  categoryId: string | null;
  answers: Record<string, FormAnswerValue>;
};

/**
 * The schema intentionally allows same-title public submissions, so no unique
 * constraint can enforce this import-only identity. A transaction-scoped
 * Postgres advisory lock serializes concurrent import retries for the same key.
 */
async function lockAbstractImportIdentity(
  tx: Prisma.TransactionClient,
  item: PreparedAbstract,
  eventId: string,
): Promise<void> {
  const identity = csvAbstractImportIdentityKey({ eventId, ...item });
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))`;
}

function stringValue(value: string, field: string, maxLength: number): string {
  const trimmed = value.trim();
  if (!trimmed) throw new CsvImportError(`${field} is required.`);
  if (trimmed.length > maxLength) throw new CsvImportError(`${field} exceeds ${maxLength} characters.`);
  return trimmed;
}

function optionalValue(value: string, maxLength: number): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) throw new CsvImportError(`Value exceeds ${maxLength} characters.`);
  return trimmed;
}

function parseDuration(value: string): number | null {
  if (!value.trim()) return null;
  const duration = Number(value);
  if (!Number.isInteger(duration) || duration < 5 || duration > 480) {
    throw new CsvImportError("durationMinutes must be an integer from 5 to 480.");
  }
  return duration;
}

/** POST /api/integrations/import — admin-only mapped CSV import for abstracts. */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, importRequestSchema);
  assertEventScope(ctx, input.eventId);
  if (input.format !== "csv" || input.entity !== "abstracts") {
    throw new ApiError(422, "UNSUPPORTED_IMPORT", "Only CSV abstract imports are available.");
  }

  const job = await prisma.importJob.create({
    data: {
      eventId: ctx.eventId,
      source: "CSV_ABSTRACTS",
      status: "PROCESSING",
      fieldMapping: input.mappings.map(({ sourceField, targetField, fallback }) =>
        fallback === undefined ? { sourceField, targetField } : { sourceField, targetField, fallback },
      ) as Prisma.InputJsonValue,
    },
  });

  try {
    const mappings = validateAbstractMappings(input.mappings);
    const mappedRows = mapCsvRows(parseCsv(input.payload), mappings);
    const [forms, categories] = await Promise.all([
      prisma.formConfig.findMany({ where: { eventId: ctx.eventId }, include: { fields: true } }),
      prisma.category.findMany({ where: { eventId: ctx.eventId } }),
    ]);
    const formsById = new Map(forms.map((form) => [form.id, form]));
    const categoriesByValue = new Map(
      categories.flatMap((category) => [
        [category.id.toLowerCase(), category.id] as const,
        [category.name.toLowerCase(), category.id] as const,
      ]),
    );

    const prepared: PreparedAbstract[] = mappedRows.map((row) => {
      try {
        const formConfigId = stringValue(row.values.formConfigId, "formConfigId", 191);
        const form = formsById.get(formConfigId);
        if (!form) throw new CsvImportError("formConfigId is not a form in this event.");
        const speakerEmail = stringValue(row.values.speakerEmail, "speakerEmail", 320).toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(speakerEmail)) {
          throw new CsvImportError("speakerEmail must be a valid email address.");
        }
        const rawAnswers = Object.fromEntries(
          Object.entries(row.values)
            .filter(([target]) => target.startsWith("answers."))
            .map(([target, value]) => [target.slice("answers.".length), value]),
        ) as Record<string, string>;
        const knownFieldKeys = new Set(form.fields.map((field) => field.key));
        const unknownAnswerKey = Object.keys(rawAnswers).find((key) => !knownFieldKeys.has(key));
        if (unknownAnswerKey) {
          throw new CsvImportError(`answers.${unknownAnswerKey} is not a field on this form.`);
        }
        const fieldsByKey = new Map(form.fields.map((field) => [field.key, field]));
        const answers = Object.fromEntries(
          Object.entries(rawAnswers).map(([key, value]) => [
            key,
            coerceCsvAnswer(value, fieldsByKey.get(key)!),
          ]),
        ) as Record<string, FormAnswerValue>;
        validateImportedAnswers(form.fields, answers);
        const validationError = validateSubmission(
          {
            // Admin imports must satisfy field and speaker requirements, but
            // intentionally may import historical submissions outside a CFP window.
            published: true,
            opensAt: null,
            closesAt: null,
            minSpeakers: form.minSpeakers,
            maxSpeakers: form.maxSpeakers,
            maxBioLength: form.maxBioLength,
            fields: form.fields.map((field) => ({
              key: field.key,
              label: field.label,
              type: field.type,
              required: field.required,
            })),
          },
          { speakerCount: 1, answers },
        );
        if (validationError) throw new CsvImportError(validationError.message);

        const categoryValue = row.values.category?.trim();
        const categoryId = categoryValue ? categoriesByValue.get(categoryValue.toLowerCase()) : null;
        if (categoryValue && !categoryId) {
          throw new CsvImportError("category is not valid for this event.");
        }
        return {
          rowNumber: row.rowNumber,
          formConfigId,
          title: stringValue(row.values.title, "title", 180),
          abstract: optionalValue(row.values.abstract ?? "", 5_000),
          format: optionalValue(row.values.format ?? "", 80),
          durationMinutes: parseDuration(row.values.durationMinutes ?? ""),
          speakerEmail,
          speakerName: stringValue(row.values.speakerName, "speakerName", 120),
          categoryId: categoryId ?? null,
          answers,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid row.";
        throw new CsvImportError(`Row ${row.rowNumber}: ${message}`);
      }
    });
    const rowKeys = new Set<string>();
    for (const item of prepared) {
      const rowKey = `${item.formConfigId}\u0000${item.speakerEmail}\u0000${item.title.toLowerCase()}`;
      if (rowKeys.has(rowKey)) throw new CsvImportError(`Row ${item.rowNumber}: duplicate abstract identity in CSV.`);
      rowKeys.add(rowKey);
    }

    const summary = await prisma.$transaction(async (tx) => {
      let created = 0;
      let updated = 0;
      let skipped = 0;
      // Every concurrent batch obtains advisory locks in the same order, which
      // prevents two overlapping CSVs from deadlocking on identities A/B.
      const preparedInLockOrder = [...prepared].sort((left, right) =>
        csvAbstractImportIdentityKey({ eventId: ctx.eventId, ...left }).localeCompare(
          csvAbstractImportIdentityKey({ eventId: ctx.eventId, ...right }),
        ),
      );
      for (const item of preparedInLockOrder) {
        // Lock before the identity read so concurrent retries cannot both
        // observe a missing row and create duplicate abstracts.
        await lockAbstractImportIdentity(tx, item, ctx.eventId);
        const speaker = await tx.user.upsert({
          where: { email: item.speakerEmail },
          update: { name: item.speakerName },
          create: { email: item.speakerEmail, name: item.speakerName },
          select: { id: true },
        });
        const matches = await tx.abstract.findMany({
          where: {
            eventId: ctx.eventId,
            formConfigId: item.formConfigId,
            submitterId: speaker.id,
            title: { equals: item.title, mode: "insensitive" },
          },
          select: { id: true, status: true },
          take: 2,
          orderBy: { createdAt: "asc" },
        });
        if (matches.length > 1) {
          throw new CsvImportError(`Row ${item.rowNumber}: existing abstract identity is ambiguous.`);
        }

        const current = matches[0];
        if (current && !["DRAFT", "SUBMITTED"].includes(current.status)) {
          skipped++;
          continue;
        }
        const abstract = current
          ? await tx.abstract.update({
              where: { id: current.id },
              data: {
                abstract: item.abstract,
                format: item.format,
                durationMinutes: item.durationMinutes,
                categoryId: item.categoryId,
              },
            })
          : await tx.abstract.create({
              data: {
                eventId: ctx.eventId,
                formConfigId: item.formConfigId,
                submitterId: speaker.id,
                title: item.title,
                abstract: item.abstract,
                format: item.format,
                durationMinutes: item.durationMinutes,
                categoryId: item.categoryId,
                status: "SUBMITTED",
                submittedAt: new Date(),
              },
            });
        if (current) updated++; else created++;

        await tx.abstractSpeaker.upsert({
          where: { abstractId_userId: { abstractId: abstract.id, userId: speaker.id } },
          update: { isPrimary: true },
          create: { abstractId: abstract.id, userId: speaker.id, isPrimary: true },
        });
        const form = formsById.get(item.formConfigId)!;
        const fieldsByKey = new Map(form.fields.map((field) => [field.key, field]));
        for (const [key, value] of Object.entries(item.answers)) {
          const field = fieldsByKey.get(key);
          if (!field) continue;
          await tx.formAnswer.upsert({
            where: { abstractId_formFieldId: { abstractId: abstract.id, formFieldId: field.id } },
            update: { value: value as Prisma.InputJsonValue },
            create: { abstractId: abstract.id, formFieldId: field.id, value: value as Prisma.InputJsonValue },
          });
        }
      }
      return { rows: prepared.length, created, updated, skipped };
    });

    const completed = await prisma.importJob.update({
      where: { id: job.id },
      data: { status: "COMPLETED", summary: summary as Prisma.InputJsonValue, error: null },
    });
    return ok({ job: completed, summary }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed.";
    const failureSummary = { error: message };
    await prisma.importJob.update({
      where: { id: job.id },
      data: { status: "FAILED", summary: failureSummary as Prisma.InputJsonValue, error: message.slice(0, 2_000) },
    });
    if (error instanceof CsvImportError) {
      return fail(422, "IMPORT_VALIDATION", message);
    }
    throw error;
  }
});
