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

/**
 * Plain-language explanation for a refused change — these users are event
 * professionals, not engineers, and this message is the entire fix from their
 * point of view.
 */
export function describeDestructiveChange(
  change: DestructiveFieldChange,
  label: string,
  answerCount: number,
): string {
  const people = `${answerCount} ${answerCount === 1 ? "submission has" : "submissions have"}`;
  switch (change.kind) {
    case "removed":
      return `${people} already answered “${label}”. Deleting or renaming this question would delete those answers. You can still reword its label and help text, or close the form to new submissions.`;
    case "retyped":
      return `${people} already answered “${label}”, so the kind of answer it accepts can no longer change. Add a new question instead.`;
    case "optionsRemoved":
      return `${people} already chosen ${change.removed.map((value) => `“${value}”`).join(", ")} for “${label}”. Removing an option someone has picked would leave their answer invalid.`;
  }
}

