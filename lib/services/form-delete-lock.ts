import type { Prisma } from "@prisma/client";
import { lockFormFieldsForShapeWrite } from "@/lib/services/form-field-lock";

export type FormDeleteUsage = {
  hasAbstract: boolean;
  hasLinkedTask: boolean;
};

async function lockLinkedOnboardingTasksForFormDelete(
  tx: Prisma.TransactionClient,
  formConfigId: string,
): Promise<Array<{ id: string }>> {
  // A linked task is enough to refuse deletion. It is the parent of every
  // SpeakerTask and its JSON responses, so preserving it preserves all task
  // history without needing to interpret or mutate those response documents.
  return tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "OnboardingTask"
    WHERE "formConfigId" = ${formConfigId}
    ORDER BY "id"
    FOR UPDATE
  `;
}

async function findAbstractForFormDelete(
  tx: Prisma.TransactionClient,
  formConfigId: string,
): Promise<{ id: string } | null> {
  // The caller already holds FormConfig FOR UPDATE. That conflicts with every
  // Abstract FK key-share acquisition, so this fresh read cannot miss a new
  // submission that later reaches the destructive delete.
  return tx.abstract.findFirst({
    where: { formConfigId },
    orderBy: { id: "asc" },
    select: { id: true },
  });
}

export type FormDeleteLockDependencies = {
  lockFields: typeof lockFormFieldsForShapeWrite;
  lockLinkedTasks: typeof lockLinkedOnboardingTasksForFormDelete;
  findAbstract: typeof findAbstractForFormDelete;
};

const productionDependencies: FormDeleteLockDependencies = {
  lockFields: lockFormFieldsForShapeWrite,
  lockLinkedTasks: lockLinkedOnboardingTasksForFormDelete,
  findAbstract: findAbstractForFormDelete,
};

/**
 * LOCK-ORDER-v1 for whole-form deletion after the caller has FormConfig FOR
 * UPDATE: sorted FormFields, then sorted linked OnboardingTask rows, followed
 * by fresh usage reads. No Abstract advisory lock is acquired: every Abstract
 * writer joins the FormConfig parent before its per-Abstract lock.
 */
export async function lockAndReadFormDeleteUsage(
  tx: Prisma.TransactionClient,
  formConfigId: string,
  dependencies: FormDeleteLockDependencies = productionDependencies,
): Promise<FormDeleteUsage> {
  await dependencies.lockFields(tx, formConfigId);
  const linkedTasks = await dependencies.lockLinkedTasks(tx, formConfigId);
  const abstract = await dependencies.findAbstract(tx, formConfigId);
  return { hasAbstract: abstract !== null, hasLinkedTask: linkedTasks.length > 0 };
}
