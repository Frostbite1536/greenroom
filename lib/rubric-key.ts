/**
 * Derive a stable rubric criterion key from the label an admin typed.
 *
 * `rubricCriterionSchema` requires `^[a-z][a-z0-9_]*$`, and the key is what
 * every persisted `ReviewScore.rubricKey` references — so it has to be valid on
 * the first try. Event staff should never see or think about it.
 */
const VALID = /^[a-z][a-z0-9_]*$/;

export function rubricKeyFromLabel(label: string, fallbackIndex: number): string {
  const key = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    // The schema requires a leading letter, so drop leading digits/underscores.
    .replace(/^[^a-z]+/, "")
    .replace(/_+$/, "")
    .slice(0, 60)
    // Slicing can re-expose a trailing underscore.
    .replace(/_+$/, "");
  return VALID.test(key) ? key : `criterion_${fallbackIndex + 1}`;
}

/**
 * Keys must be unique within a rubric: two criteria sharing one key would
 * silently collapse into a single stored score.
 */
export function uniqueRubricKeys(labels: string[]): string[] {
  const seen = new Set<string>();
  return labels.map((label, i) => {
    const base = rubricKeyFromLabel(label, i);
    if (!seen.has(base)) {
      seen.add(base);
      return base;
    }
    let n = 2;
    while (seen.has(`${base}_${n}`)) n++;
    const key = `${base}_${n}`;
    seen.add(key);
    return key;
  });
}
