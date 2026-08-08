import type { Category, FormConfig, FormField } from "@prisma/client";

type PublicFormWithRelations = FormConfig & {
  fields: FormField[];
  event?: {
    name?: string;
    categories?: Pick<Category, "id" | "name">[];
  };
};

/** Serialized form field for both admin and public consumers. */
export function serializeField(field: FormField) {
  return {
    id: field.id,
    key: field.key,
    label: field.label,
    helpText: field.helpText,
    type: field.type,
    required: field.required,
    options: field.options ?? null,
    conditionalLogic: field.conditionalLogic ?? null,
    sortOrder: field.sortOrder,
  };
}

/** Full form config for admin surfaces. */
export function serializeForm(form: FormConfig & { fields: FormField[] }) {
  return {
    id: form.id,
    eventId: form.eventId,
    name: form.name,
    slug: form.slug,
    welcomeText: form.welcomeText,
    thankYouText: form.thankYouText,
    opensAt: form.opensAt?.toISOString() ?? null,
    closesAt: form.closesAt?.toISOString() ?? null,
    submissionLimit: form.submissionLimit,
    minSpeakers: form.minSpeakers,
    maxSpeakers: form.maxSpeakers,
    maxBioLength: form.maxBioLength,
    published: form.published,
    fields: [...form.fields]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(serializeField),
  };
}

/**
 * Public projection: strip internal timing/limits the submitter should not see
 * as raw config, keep what the renderer needs. Window state is derived server
 * side and returned as booleans.
 */
export function serializePublicForm(
  form: PublicFormWithRelations,
  now: Date = new Date(),
) {
  const isOpen =
    form.published &&
    (!form.opensAt || now >= form.opensAt) &&
    (!form.closesAt || now < form.closesAt);
  return {
    id: form.id,
    eventId: form.eventId,
    name: form.name,
    slug: form.slug,
    welcomeText: form.welcomeText,
    thankYouText: form.thankYouText,
    opensAt: form.opensAt?.toISOString() ?? null,
    closesAt: form.closesAt?.toISOString() ?? null,
    minSpeakers: form.minSpeakers,
    maxSpeakers: form.maxSpeakers,
    maxBioLength: form.maxBioLength,
    isOpen,
    // Categories are event-owned, so this public projection is sufficient for
    // an unauthenticated submitter without exposing the protected categories API.
    categories: (form.event?.categories ?? []).map((category) => ({
      id: category.id,
      name: category.name,
    })),
    fields: [...form.fields]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(serializeField),
  };
}
