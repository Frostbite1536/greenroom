import type {
  Abstract,
  AbstractSpeaker,
  Category,
  FormAnswer,
  ReviewAssignment,
  ReviewScore,
  User,
} from "@prisma/client";

type AbstractWithRelations = Abstract & {
  category?: Category | null;
  speakers?: (AbstractSpeaker & { user: User })[];
  answers?: FormAnswer[];
  reviewAssignments?: Pick<ReviewAssignment, "status">[];
  reviewScores?: Pick<ReviewScore, "score">[];
};

/** Serialize an abstract for admin tables and speaker portal reads. */
export function serializeAbstract(abstract: AbstractWithRelations) {
  const reviewAssignments = abstract.reviewAssignments ?? [];
  const reviewScores = abstract.reviewScores ?? [];
  const averageScore =
    reviewScores.length > 0
      ? reviewScores.reduce((sum, review) => sum + Number(review.score), 0) /
        reviewScores.length
      : null;

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
      // Per-proposal contribution label ("Co-presenter"), null when unstated.
      // Additive: existing clients that ignore it are unaffected, and the
      // public draft response carries it so a resumed draft rehydrates it.
      role: s.role,
    })),
    answers: Object.fromEntries(
      (abstract.answers ?? []).map((a) => [a.formFieldId, a.value]),
    ),
    // These field names match the admin pipeline's existing row contract.
    // Relations are included by the list query, avoiding a per-abstract query.
    reviewsComplete: reviewAssignments.filter((review) => review.status === "COMPLETED").length,
    reviewsTotal: reviewAssignments.length,
    avgScore: averageScore,
  };
}

/**
 * The admin decision surface receives a selected-round summary separately.
 * Never expose the legacy raw all-round average there: it mixes plans and
 * partial criteria, and is not a safe decision metric.
 */
export function serializeAdminAbstract(abstract: AbstractWithRelations) {
  const {
    avgScore: _avgScore,
    reviewsComplete: _reviewsComplete,
    reviewsTotal: _reviewsTotal,
    ...serialized
  } = serializeAbstract(abstract);
  return serialized;
}
