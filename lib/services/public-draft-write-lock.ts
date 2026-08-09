import type { Prisma } from "@prisma/client";
import { lockAbstractForWrite } from "@/lib/services/abstract-lock";
import {
  lockFormConfigForAnswerWrite,
  type LockedFormConfig,
} from "@/lib/services/form-config-lock";
import {
  lockCurrentFormFieldsForAnswerWrite,
  type LockedFormField,
} from "@/lib/services/form-field-lock";
import { lockPublicSubmissionIdentities } from "@/lib/services/public-submission";

export type PublicDraftWriteLocks = {
  form: LockedFormConfig;
  fields: LockedFormField[];
};

export type PublicDraftWriteLockDependencies = {
  lockFormConfig: typeof lockFormConfigForAnswerWrite;
  lockCurrentFields: typeof lockCurrentFormFieldsForAnswerWrite;
  lockIdentities: typeof lockPublicSubmissionIdentities;
  lockAbstract: typeof lockAbstractForWrite;
};

const productionDependencies: PublicDraftWriteLockDependencies = {
  lockFormConfig: lockFormConfigForAnswerWrite,
  lockCurrentFields: lockCurrentFormFieldsForAnswerWrite,
  lockIdentities: lockPublicSubmissionIdentities,
  lockAbstract: lockAbstractForWrite,
};

/**
 * LOCK-ORDER-v1 for public writers. Existing draft writes join the final
 * Abstract class only after the public FormConfig/FormField/identity classes.
 */
export async function lockPublicDraftWrite(
  tx: Prisma.TransactionClient,
  input: { formConfigId: string; speakerEmails: readonly string[]; abstractId?: string },
  dependencies: PublicDraftWriteLockDependencies = productionDependencies,
): Promise<PublicDraftWriteLocks | null> {
  const form = await dependencies.lockFormConfig(tx, input.formConfigId);
  if (!form) return null;

  const fields = await dependencies.lockCurrentFields(tx, form.id);
  await dependencies.lockIdentities(tx, input.speakerEmails);
  if (input.abstractId) await dependencies.lockAbstract(tx, input.abstractId);
  return { form, fields };
}
