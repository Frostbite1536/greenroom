import type { Prisma } from "@prisma/client";

export type LockedFormConfig = {
  id: string;
  eventId: string;
  published: boolean;
  opensAt: Date | null;
  closesAt: Date | null;
  minSpeakers: number;
  maxSpeakers: number;
  maxBioLength: number;
  submissionLimit: number | null;
};

/**
 * LOCK-ORDER-v1 for public answer writers: FormConfig, then sorted FormFields,
 * then sorted identity locks. FOR SHARE conflicts with an operator's form
 * update, so publication/window policy cannot turn stale between validation
 * and persistence.
 */
export async function lockFormConfigForAnswerWrite(
  tx: Prisma.TransactionClient,
  formConfigId: string,
): Promise<LockedFormConfig | null> {
  const rows = await tx.$queryRaw<LockedFormConfig[]>`
    SELECT "id", "eventId", "published", "opensAt", "closesAt", "minSpeakers", "maxSpeakers", "maxBioLength", "submissionLimit"
    FROM "FormConfig"
    WHERE "id" = ${formConfigId}
    FOR SHARE
  `;
  return rows[0] ?? null;
}

/** Shape writers acquire the same parent row first, but exclusively. */
export async function lockFormConfigForShapeWrite(
  tx: Prisma.TransactionClient,
  formConfigId: string,
): Promise<LockedFormConfig | null> {
  const rows = await tx.$queryRaw<LockedFormConfig[]>`
    SELECT "id", "eventId", "published", "opensAt", "closesAt", "minSpeakers", "maxSpeakers", "maxBioLength", "submissionLimit"
    FROM "FormConfig"
    WHERE "id" = ${formConfigId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}
