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

export type SpeakerContentWriteLocks = {
  form: LockedFormConfig;
  fields: LockedFormField[];
};

export type SpeakerContentWriteLockDependencies = {
  lockFormConfig: typeof lockFormConfigForAnswerWrite;
  lockCurrentFields: typeof lockCurrentFormFieldsForAnswerWrite;
  lockAbstract: typeof lockAbstractForWrite;
};

const productionDependencies: SpeakerContentWriteLockDependencies = {
  lockFormConfig: lockFormConfigForAnswerWrite,
  lockCurrentFields: lockCurrentFormFieldsForAnswerWrite,
  lockAbstract: lockAbstractForWrite,
};

/**
 * LOCK-ORDER-v1 for an authenticated speaker content/roster PATCH. The public
 * writer already takes FormConfig then FormField locks; this helper keeps the
 * speaker writer in that same order before it joins per-Abstract serialization.
 */
export async function lockSpeakerContentWrite(
  tx: Prisma.TransactionClient,
  input: { formConfigId: string; abstractId: string },
  dependencies: SpeakerContentWriteLockDependencies = productionDependencies,
): Promise<SpeakerContentWriteLocks | null> {
  const form = await dependencies.lockFormConfig(tx, input.formConfigId);
  if (!form) return null;

  const fields = await dependencies.lockCurrentFields(tx, form.id);
  await dependencies.lockAbstract(tx, input.abstractId);
  return { form, fields };
}
