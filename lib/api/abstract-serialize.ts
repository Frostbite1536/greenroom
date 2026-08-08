import type {
  Abstract,
  AbstractSpeaker,
  Category,
  FormAnswer,
  User,
} from "@prisma/client";

type AbstractWithRelations = Abstract & {
  category?: Category | null;
  speakers?: (AbstractSpeaker & { user: User })[];
  answers?: FormAnswer[];
};

/** Serialize an abstract for admin tables and speaker portal reads. */
export function serializeAbstract(abstract: AbstractWithRelations) {
  return {
    id: abstract.id,
    eventId: abstract.eventId,
    formConfigId: abstract.formConfigId,
    submitterId: abstract.submitterId,
    title: abstract.title,
    abstract: abstract.abstract,
    format: abstract.format,
    durationMinutes: abstract.durationMinutes,
    categoryId: abstract.categoryId,
    category: abstract.category
      ? { id: abstract.category.id, name: abstract.category.name }
      : null,
    status: abstract.status,
    submittedAt: abstract.submittedAt?.toISOString() ?? null,
    decidedAt: abstract.decidedAt?.toISOString() ?? null,
    speakers: (abstract.speakers ?? []).map((s) => ({
      userId: s.userId,
      email: s.user.email,
      name: s.user.name,
      isPrimary: s.isPrimary,
    })),
    answers: Object.fromEntries(
      (abstract.answers ?? []).map((a) => [a.formFieldId, a.value]),
    ),
  };
}
