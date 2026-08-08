/**
 * Pure helpers for CFP form-config writes and public form resolution.
 *
 * These exist so the create-new-form flow (`POST /api/cfp/forms` with no `id`)
 * fails with stable, actionable contract errors instead of leaking a Prisma
 * uniqueness violation as a 500, and so the public `/cfp/:formId` lookup —
 * which accepts either an id or an event-scoped slug — resolves to exactly one
 * form deterministically.
 */

/** Field keys that appear more than once in a form payload, in first-seen order. */
export function findDuplicateFieldKeys(fields: readonly { key: string }[]): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const field of fields) {
    if (seen.has(field.key)) {
      if (!duplicates.includes(field.key)) duplicates.push(field.key);
      continue;
    }
    seen.add(field.key);
  }
  return duplicates;
}

export type FormIdentity = { id: string; slug: string };

/**
 * Resolve a public form identifier against candidate rows.
 *
 * `FormConfig.slug` is only unique per event and its allowed character set can
 * also match a generated id, so a raw `OR: [{ id }, { slug }]` lookup is
 * ambiguous across events. Precedence: exact id, then slug ordered by id, so
 * the same URL always resolves to the same form and a slug can never shadow
 * another form's id-based URL.
 */
export function resolvePublicForm<T extends FormIdentity>(
  identifier: string,
  candidates: readonly T[],
): T | null {
  const byId = candidates.find((form) => form.id === identifier);
  if (byId) return byId;
  const bySlug = candidates
    .filter((form) => form.slug === identifier)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return bySlug[0] ?? null;
}
