/**
 * Pure helpers for CFP form-config writes.
 *
 * These exist so the create-new-form flow (`POST /api/cfp/forms` with no `id`)
 * fails with stable, actionable contract errors instead of leaking a Prisma
 * uniqueness violation as a 500. Public `/cfp/:formId` resolution precedence
 * (exact id, then lowest-id slug match) is enforced by ordered queries in
 * `app/api/cfp/public/[formId]/route.ts`.
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

