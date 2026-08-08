/**
 * Evaluation rubric helpers. A `ReviewScore` must reference a rubric key that
 * exists in its plan and fall within that criterion's [min, max] range
 * (INV-EVAL-001). The plan stores its rubric as JSON; parse defensively.
 */
export type RubricCriterion = {
  key: string;
  label: string;
  min: number;
  max: number;
  weight: number;
};

export function parseRubric(raw: unknown): RubricCriterion[] {
  if (!Array.isArray(raw)) return [];
  const out: RubricCriterion[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as Record<string, unknown>).key === "string" &&
      typeof (item as Record<string, unknown>).min === "number" &&
      typeof (item as Record<string, unknown>).max === "number"
    ) {
      const c = item as Record<string, unknown>;
      out.push({
        key: c.key as string,
        label: (c.label as string) ?? (c.key as string),
        min: c.min as number,
        max: c.max as number,
        weight: typeof c.weight === "number" ? (c.weight as number) : 1,
      });
    }
  }
  return out;
}

export type ScoreEntry = { rubricKey: string; score: number };

export type ScoreValidationError = {
  code: string;
  message: string;
  fieldErrors?: Record<string, string[]>;
};

/** Validate a set of score entries against a plan rubric. */
export function validateScores(
  rubric: RubricCriterion[],
  entries: ScoreEntry[],
): ScoreValidationError | null {
  const byKey = new Map(rubric.map((c) => [c.key, c]));
  const fieldErrors: Record<string, string[]> = {};

  for (const entry of entries) {
    const criterion = byKey.get(entry.rubricKey);
    if (!criterion) {
      (fieldErrors[entry.rubricKey] ??= []).push("Unknown rubric criterion.");
      continue;
    }
    if (entry.score < criterion.min || entry.score > criterion.max) {
      (fieldErrors[entry.rubricKey] ??= []).push(
        `Score must be between ${criterion.min} and ${criterion.max}.`,
      );
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { code: "INVALID_SCORES", message: "One or more scores are invalid.", fieldErrors };
  }
  return null;
}

/** Weighted average of a complete set of criterion scores (for ranking). */
export function weightedScore(
  rubric: RubricCriterion[],
  scoresByKey: Record<string, number>,
): number {
  let total = 0;
  let weight = 0;
  for (const criterion of rubric) {
    const value = scoresByKey[criterion.key];
    if (typeof value === "number") {
      total += value * criterion.weight;
      weight += criterion.weight;
    }
  }
  return weight === 0 ? 0 : total / weight;
}
