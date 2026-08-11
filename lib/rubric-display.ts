/**
 * Read-only rendering of a **stored** rubric, for organizers.
 *
 * The evaluations workspace could tell an organizer how many criteria a round
 * had — `4 criteria` — but never what they were or how much each one counted.
 * Reviewers scored against a rubric the person reading the resulting scores
 * could not see. Everything here is display only: no weight is repaired, no
 * score is recomputed, and the scoring formula in
 * `lib/services/admin-decision-summary.ts` is untouched.
 *
 * Weights are **relative multipliers**, not percentages (D-C5-8 §2.2), so the
 * number that actually answers "how much does this count?" is the criterion's
 * *share* of the round's total weight. The share wording is
 * `lib/rubric-weight.ts`'s, reused verbatim rather than re-spelt, so the
 * read-only view and the round editor cannot drift apart.
 *
 * Defensive by construction: a rubric arrives as `Prisma.Json` cast to a view
 * type, so the compiler's guarantee stops at the database boundary. An entry
 * whose key or label cannot be read is **dropped** rather than rendered as
 * `undefined` — and a rubric that yields no readable line at all lets the
 * caller say so, which is the honest state for a legacy round whose scores
 * `parseDecisionRubric` also refuses.
 */
import { formatRubricWeightNumber, rubricWeightShare } from "@/lib/rubric-weight";

/** The stored shape, structurally `RubricCriterionView` from `lib/data/reads`. */
export type StoredRubricCriterion = {
  key: string;
  label: string;
  description?: string;
  min: number;
  max: number;
  weight: number;
};

export type RubricCriterionLine = {
  key: string;
  label: string;
  /** `1–5`, or an empty string when the stored range is unreadable. */
  range: string;
  /** Null when the weight, or the round's total weight, cannot be read. */
  sharePercent: number | null;
  /** `Weight 1.5 · 33.3% of rubric weight · scores 1–5`. */
  meta: string;
};

function readableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readableRange(min: unknown, max: unknown): string {
  if (typeof min !== "number" || typeof max !== "number") return "";
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return "";
  // En dash, matching the range punctuation used elsewhere in the product.
  return `${min}–${max}`;
}

/**
 * One display line per readable criterion, in stored order.
 *
 * Shares are computed against the total of every **readable** weight in the
 * rubric, so they still sum to 100% across the lines actually shown rather
 * than silently under-counting against a criterion that was dropped.
 */
export function rubricCriterionLines(
  rubric: readonly StoredRubricCriterion[] | null | undefined,
): RubricCriterionLine[] {
  if (!Array.isArray(rubric)) return [];

  const readable = rubric.filter((criterion) =>
    criterion !== null
    && typeof criterion === "object"
    && readableString(criterion.key) !== null
    && readableString(criterion.label) !== null);

  const weights = readable.map((criterion) =>
    typeof criterion.weight === "number" ? criterion.weight : null);

  return readable.map((criterion, index) => {
    const key = readableString(criterion.key) ?? "";
    const label = readableString(criterion.label) ?? "";
    const range = readableRange(criterion.min, criterion.max);
    const weight = weights[index];
    const share = rubricWeightShare(weight, weights);

    const parts: string[] = [];
    // An unreadable weight is left out rather than printed as `Weight NaN` or
    // repaired to 1 — the same refusal the round editor makes.
    if (weight !== null && Number.isFinite(weight)) {
      parts.push(`Weight ${formatRubricWeightNumber(weight)}`);
    }
    if (share !== null) parts.push(`${formatRubricWeightNumber(share)}% of rubric weight`);
    if (range !== "") parts.push(`scores ${range}`);

    return { key, label, range, sharePercent: share, meta: parts.join(" · ") };
  });
}
