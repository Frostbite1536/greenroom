/** Format only finite server-projected decision aggregates for display. */
export function formatDecisionScore(value: number | null): string | null {
  return value !== null && Number.isFinite(value) ? value.toFixed(2) : null;
}
