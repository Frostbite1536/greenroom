import type { Prisma } from "@prisma/client";

export type FormFieldSnapshot = { id: string; updatedAt: Date };

/** Exact shape/version comparison used after an answer writer obtains locks. */
export function formFieldSnapshotsMatch(
  expected: readonly FormFieldSnapshot[],
  locked: readonly FormFieldSnapshot[],
): boolean {
  if (expected.length !== locked.length) return false;
  const expectedById = new Map(expected.map((field) => [field.id, field.updatedAt.getTime()]));
  return locked.every((field) => expectedById.get(field.id) === field.updatedAt.getTime());
}

/**
 * Serialize a form-shape edit against answer writers and competing saves.
 * Ordered row acquisition keeps multi-request contention deterministic.
 */
export async function lockFormFieldsForShapeWrite(
  tx: Prisma.TransactionClient,
  formConfigId: string,
): Promise<void> {
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "FormField"
    WHERE "formConfigId" = ${formConfigId}
    ORDER BY "id"
    FOR UPDATE
  `;
}

/**
 * Hold key-share locks from validation through answer persistence.
 *
 * Form edits take `FOR UPDATE`, which conflicts with these locks. The snapshot
 * check handles the other ordering: if an edit committed after the caller read
 * the form but before it obtained these locks, return false so the route can
 * ask for a clean retry instead of writing against stale field definitions.
 */
export async function lockFormFieldsForAnswerWrite(
  tx: Prisma.TransactionClient,
  expectedByFormId: ReadonlyMap<string, readonly FormFieldSnapshot[]>,
): Promise<boolean> {
  for (const formConfigId of [...expectedByFormId.keys()].sort()) {
    const locked = await tx.$queryRaw<FormFieldSnapshot[]>`
      SELECT "id", "updatedAt"
      FROM "FormField"
      WHERE "formConfigId" = ${formConfigId}
      ORDER BY "id"
      FOR KEY SHARE
    `;
    if (!formFieldSnapshotsMatch(expectedByFormId.get(formConfigId) ?? [], locked)) {
      return false;
    }
  }
  return true;
}
