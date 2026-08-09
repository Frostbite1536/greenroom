/**
 * Pure helpers for CFP form-config writes.
 *
 * These exist so the create-new-form flow (`POST /api/cfp/forms` with no `id`)
 * fails with stable, actionable contract errors instead of leaking a Prisma
 * uniqueness violation as a 500. Legacy public `/cfp/:formId` resolution uses
 * an exact published ID or one unambiguous published slug in
 * `public-form-resolver.ts`; it never selects a lowest-id collision.
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

/**
 * Field changes that would destroy answers people have already submitted
 * (WAVE1-B5 / audit2#1).
 *
 * `FormAnswer` cascades from `FormField`, so reconciling a form by deleting the
 * fields missing from the payload silently deletes submitted answers — and a
 * key rename is exactly that: a delete plus a create. Label, help text, order
 * and required-ness stay freely editable.
 */
export type StoredField = {
  key: string;
  type: string;
  options: readonly { value: string }[] | null;
};

export type IncomingField = {
  key: string;
  type: string;
  options?: readonly { value: string }[] | null;
};

export type DestructiveFieldChange =
  | { kind: "removed"; key: string }
  | { kind: "retyped"; key: string; from: string; to: string }
  | { kind: "optionsRemoved"; key: string; removed: string[] };

/**
 * Compare stored fields with an incoming payload and report changes that would
 * invalidate or delete existing answers. Purely structural — whether answers
 * actually exist is checked by the caller against the database.
 */
export function findDestructiveFieldChanges(
  stored: readonly StoredField[],
  incoming: readonly IncomingField[],
): DestructiveFieldChange[] {
  const incomingByKey = new Map(incoming.map((field) => [field.key, field]));
  const changes: DestructiveFieldChange[] = [];

  for (const field of stored) {
    const next = incomingByKey.get(field.key);
    if (!next) {
      // Covers renames too: the old key simply is not in the payload.
      changes.push({ kind: "removed", key: field.key });
      continue;
    }
    if (next.type !== field.type) {
      changes.push({ kind: "retyped", key: field.key, from: field.type, to: next.type });
      continue;
    }
    const before = (field.options ?? []).map((option) => option.value);
    const after = new Set((next.options ?? []).map((option) => option.value));
    const removed = before.filter((value) => !after.has(value));
    if (removed.length > 0) {
      changes.push({ kind: "optionsRemoved", key: field.key, removed });
    }
  }

  return changes;
}

/** The option values one stored answer uses, for the in-use check. */
export function answerOptionValues(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

/** Whether a JSON task-form value represents an answer worth protecting. */
export function hasAnswerValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
  return typeof value === "number" || typeof value === "boolean";
}

export type AnswerOptionRow = {
  id: string;
  formFieldId: string;
  value: unknown;
};

/**
 * Exhaustively find which candidate option values are already used.
 *
 * The caller supplies deterministic cursor pages so this stays database-free
 * and testable. Only candidate values are retained in memory. If all removed
 * options are found, scanning can stop early; otherwise every page is read so
 * an option used after an arbitrary boundary cannot be missed.
 */
export async function findUsedRemovedOptions(
  removedByFieldId: ReadonlyMap<string, ReadonlySet<string>>,
  loadPage: (afterId: string | null, take: number) => Promise<readonly AnswerOptionRow[]>,
  pageSize = 500,
): Promise<Map<string, Set<string>>> {
  if (pageSize < 1) throw new Error("Answer scan page size must be positive.");

  const used = new Map<string, Set<string>>();
  let remaining = [...removedByFieldId.values()].reduce((total, values) => total + values.size, 0);
  let afterId: string | null = null;

  while (remaining > 0) {
    const page = await loadPage(afterId, pageSize);
    if (page.length === 0) break;

    for (const answer of page) {
      const candidates = removedByFieldId.get(answer.formFieldId);
      if (!candidates) continue;
      const found = used.get(answer.formFieldId) ?? new Set<string>();
      for (const value of answerOptionValues(answer.value)) {
        if (candidates.has(value) && !found.has(value)) {
          found.add(value);
          remaining -= 1;
        }
      }
      if (found.size > 0) used.set(answer.formFieldId, found);
    }

    if (remaining === 0 || page.length < pageSize) break;
    const nextAfterId = page[page.length - 1]?.id ?? null;
    if (!nextAfterId || nextAfterId === afterId) {
      throw new Error("Answer scan cursor did not advance.");
    }
    afterId = nextAfterId;
  }

  return used;
}

/**
 * Plain-language explanation for a refused change — these users are event
 * professionals, not engineers, and this message is the entire fix from their
 * point of view.
 */
export function describeDestructiveChange(
  change: DestructiveFieldChange,
  label: string,
  answerCount: number,
  source: "submission" | "saved response" = "submission",
): string {
  const people = source === "submission"
    ? `${answerCount} ${answerCount === 1 ? "submission has already answered" : "submissions have already answered"}`
    : `${answerCount} saved ${answerCount === 1 ? "response contains an answer to" : "responses contain answers to"}`;
  switch (change.kind) {
    case "removed":
      return `${people} “${label}”. Deleting or renaming this question would delete those answers. You can still reword its label and help text, or close the form to new submissions.`;
    case "retyped":
      return `${people} “${label}”, so the kind of answer it accepts can no longer change. Add a new question instead.`;
    case "optionsRemoved":
      return source === "submission"
        ? `${answerCount} ${answerCount === 1 ? "submission has" : "submissions have"} already chosen ${change.removed.map((value) => `“${value}”`).join(", ")} for “${label}”. Removing an option someone has picked would leave their answer invalid.`
        : `${answerCount} saved ${answerCount === 1 ? "response uses" : "responses use"} ${change.removed.map((value) => `“${value}”`).join(", ")} for “${label}”. Removing an option someone has picked would leave their answer invalid.`;
  }
}

