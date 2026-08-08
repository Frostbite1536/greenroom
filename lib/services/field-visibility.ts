import { isFieldVisible, type ConditionalLogic, type LogicField } from "@/lib/form-logic";
import type { FormAnswerValue } from "@/lib/services/types";

/**
 * Server-side conditional visibility and typed answer checks (WAVE1-B2).
 *
 * `lib/form-logic.ts` has always documented that the server enforces the same
 * rules; audit2#3 showed it did not, and that the mismatch actively broke valid
 * submissions: the renderer only sends answers for *visible* fields, so a
 * required field hidden by conditional logic arrived missing and was rejected.
 *
 * Rule evaluation is imported from `lib/form-logic.ts` rather than reimplemented
 * here, so the client preview and the server can never disagree about what a
 * rule means. What this module adds is the parts a server must own: cascading
 * visibility, and type/option enforcement the client cannot be trusted for.
 */

export type FieldOption = { label: string; value: string };

export type VisibilityField = LogicField & {
  label: string;
  options?: FieldOption[] | null;
};

/** Defensive parse of the `FormField.options` JSON column. */
export function parseFieldOptions(raw: unknown): FieldOption[] | null {
  if (!Array.isArray(raw)) return null;
  const options: FieldOption[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { label?: unknown; value?: unknown };
    if (typeof candidate.value !== "string") continue;
    options.push({
      label: typeof candidate.label === "string" ? candidate.label : candidate.value,
      value: candidate.value,
    });
  }
  return options.length > 0 ? options : null;
}

/** Defensive parse of the `FormField.conditionalLogic` JSON column. */
export function parseConditionalLogic(raw: unknown): ConditionalLogic | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as { match?: unknown; rules?: unknown };
  if (candidate.match !== "all" && candidate.match !== "any") return null;
  if (!Array.isArray(candidate.rules) || candidate.rules.length === 0) return null;
  const rules = candidate.rules.flatMap((rule) => {
    if (!rule || typeof rule !== "object") return [];
    const entry = rule as { fieldKey?: unknown; operator?: unknown; value?: unknown };
    if (typeof entry.fieldKey !== "string" || typeof entry.operator !== "string") return [];
    const value =
      typeof entry.value === "string" ||
      typeof entry.value === "number" ||
      typeof entry.value === "boolean"
        ? entry.value
        : undefined;
    return [{ fieldKey: entry.fieldKey, operator: entry.operator, value }];
  });
  return rules.length > 0 ? { match: candidate.match, rules } : null;
}

function isBlank(value: FormAnswerValue | undefined): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Which fields are actually being asked, given the answers so far.
 *
 * Visibility cascades: if a field is hidden, any answer stored against it from
 * an earlier state must not keep a dependent field alive. That is resolved by
 * re-evaluating with hidden answers masked out until the set stops changing.
 * The pass count is bounded by the field count, so a circular rule set settles
 * instead of looping.
 */
export function resolveVisibleFields<T extends VisibilityField>(
  fields: readonly T[],
  answers: Readonly<Record<string, FormAnswerValue>>,
): T[] {
  let visibleKeys = new Set(fields.map((field) => field.key));

  for (let pass = 0; pass <= fields.length; pass++) {
    // Start from the submitted answers so rule evaluation matches the client's
    // exactly, then mask only the answers of fields that are currently hidden.
    const effective: Record<string, FormAnswerValue> = { ...answers };
    for (const field of fields) {
      if (!visibleKeys.has(field.key)) delete effective[field.key];
    }

    const next = new Set<string>();
    for (const field of fields) {
      if (isFieldVisible(field, effective)) next.add(field.key);
    }

    const stable =
      next.size === visibleKeys.size && [...next].every((key) => visibleKeys.has(key));
    visibleKeys = next;
    if (stable) break;
  }

  return fields.filter((field) => visibleKeys.has(field.key));
}

/**
 * Type and option enforcement for one answered field. Returns a user-facing
 * message or null. Empty values are the required check's job, not this one's.
 *
 * The client sends `<input>` values, so a numeric string is accepted for NUMBER
 * exactly as the renderer's own validator accepts it; anything that is not a
 * number at all is refused.
 */
export function validateAnswerType(
  field: VisibilityField,
  value: FormAnswerValue | undefined,
): string | null {
  if (field.type === "CHECKBOX") {
    // A checkbox is only ever true/false; `null` means "not answered".
    if (value === null || value === undefined) return null;
    if (typeof value !== "boolean") return "Answer this with a yes/no tick.";
    return null;
  }

  if (isBlank(value)) return null;

  switch (field.type) {
    case "NUMBER": {
      const numeric = typeof value === "number" ? value : Number(value);
      if (typeof value === "boolean" || Array.isArray(value) || !Number.isFinite(numeric)) {
        return "Enter a number.";
      }
      return null;
    }
    case "URL": {
      if (typeof value !== "string") return "Enter a valid link (including https://).";
      try {
        new URL(value);
      } catch {
        return "Enter a valid link (including https://).";
      }
      return null;
    }
    case "SELECT": {
      if (typeof value !== "string") return "Choose one of the listed options.";
      const allowed = (field.options ?? []).map((option) => option.value);
      if (allowed.length > 0 && !allowed.includes(value)) {
        return "Choose one of the listed options.";
      }
      return null;
    }
    case "MULTI_SELECT": {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        return "Choose from the listed options.";
      }
      const allowed = (field.options ?? []).map((option) => option.value);
      if (allowed.length > 0 && value.some((entry) => !allowed.includes(entry))) {
        return "Choose from the listed options.";
      }
      if (new Set(value).size !== value.length) return "Each option can only be chosen once.";
      return null;
    }
    case "SHORT_TEXT":
    case "LONG_TEXT": {
      if (typeof value !== "string") return "Enter this as text.";
      return null;
    }
    default:
      return null;
  }
}
