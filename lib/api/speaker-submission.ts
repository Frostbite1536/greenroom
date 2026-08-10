import type {
  Abstract,
  AbstractSpeaker,
  Category,
  FormAnswer,
  FormConfig,
  FormField,
  User,
} from "@prisma/client";
import { serializeAbstract } from "@/lib/api/abstract-serialize";
import { serializeField } from "@/lib/api/form-serialize";
import { speakerEditRefusal } from "@/lib/services/speaker-edit";
import type { FormAnswerValue } from "@/lib/services/types";

/**
 * Serialization for the speaker-facing submission surface (R1).
 *
 * The portal renders these, so every projection stays limited to the abstract's
 * own record plus the form spec needed to draw the fields. Review assignments,
 * scores, and evaluator comments are deliberately absent: a speaker must never
 * see their own review data.
 */

export type SubmissionRelations = Abstract & {
  category?: Category | null;
  speakers?: (AbstractSpeaker & { user: User })[];
  answers?: FormAnswer[];
  /**
   * `closesAt` is required, not optional: CFP-16 makes the edit affordance
   * depend on it, so a caller that forgets to select it must fail typecheck
   * rather than silently report a closed proposal as editable.
   */
  formConfig?: Pick<FormConfig, "id" | "name" | "slug" | "closesAt"> | null;
  session?: { id: string; scheduleSlot?: { id: string } | null } | null;
};

/**
 * A submission as the speaker sees it: the shared abstract shape plus the edit
 * affordances the portal needs. `speakersLocked` is true once the abstract has
 * been converted, because the confirmed `Session` copied the roster and must
 * not silently disagree with it (INV-DOMAIN-001).
 */
export function serializeSpeakerSubmission(abstract: SubmissionRelations) {
  const hasSession = Boolean(abstract.session);
  // The same rule the PATCH route enforces under its locks, so the portal never
  // offers an edit the server will refuse. Withdrawal is deliberately unaffected
  // — it has its own affordance and stays available after the CFP closes.
  const refusal = speakerEditRefusal(abstract.status, abstract.formConfig?.closesAt ?? null);
  return {
    ...serializeAbstract(abstract),
    form: abstract.formConfig
      ? { id: abstract.formConfig.id, name: abstract.formConfig.name, slug: abstract.formConfig.slug }
      : null,
    canEdit: refusal === null,
    lockReason: refusal?.message ?? null,
    speakersLocked: hasSession,
    isScheduled: hasSession && Boolean(abstract.session?.scheduleSlot),
  };
}

/** Stored answers projected by form field *key* for the field renderer. */
export function answersByKey(
  answers: readonly FormAnswer[],
  fields: readonly Pick<FormField, "id" | "key">[],
): Record<string, FormAnswerValue> {
  const keyByFieldId = new Map(fields.map((field) => [field.id, field.key]));
  const result: Record<string, FormAnswerValue> = {};
  for (const answer of answers) {
    const key = keyByFieldId.get(answer.formFieldId);
    if (key) result[key] = answer.value as FormAnswerValue;
  }
  return result;
}

/**
 * The form spec the portal needs to render an edit form. Intentionally omits
 * `isOpen`/`opensAt`/`closesAt`: whether this speaker may still edit is already
 * answered by `canEdit`/`lockReason` above, which apply the CFP-16 close-date
 * rule together with the status rule. Re-deriving it from raw window fields in
 * the client is exactly how the two would drift apart.
 */
export function serializeEditFormSpec(
  form: FormConfig & { fields: FormField[] },
  categories: readonly Pick<Category, "id" | "name">[],
) {
  return {
    id: form.id,
    name: form.name,
    minSpeakers: form.minSpeakers,
    maxSpeakers: form.maxSpeakers,
    maxBioLength: form.maxBioLength,
    fields: [...form.fields].sort((a, b) => a.sortOrder - b.sortOrder).map(serializeField),
    categories: categories.map((category) => ({ id: category.id, name: category.name })),
  };
}
