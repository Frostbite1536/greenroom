/**
 * Client-side conditional-logic evaluation and field validation.
 *
 * Mirrors the `conditionalLogic` contract in `types/api.ts` and the required /
 * type rules the backend enforces in `lib/services/form-validation.ts`. Used by
 * both the form builder preview and the public CFP renderer so authoring and
 * submission behave identically. The server stays authoritative.
 */
export type AnswerValue = string | number | boolean | string[] | null | undefined;
export type AnswerMap = Record<string, AnswerValue>;

export type LogicRule = {
  fieldKey: string;
  operator: string;
  value?: string | number | boolean;
};

export type ConditionalLogic = {
  match: "all" | "any";
  rules: LogicRule[];
};

/** Minimal field shape the renderer and validator need. */
export type LogicField = {
  key: string;
  type: string;
  required: boolean;
  conditionalLogic?: ConditionalLogic | null;
};

function isBlank(value: AnswerValue): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function ruleMatches(rule: LogicRule, answers: AnswerMap): boolean {
  const actual = answers[rule.fieldKey];
  switch (rule.operator) {
    case "isEmpty":
      return isBlank(actual);
    case "isNotEmpty":
      return !isBlank(actual);
    case "equals":
      if (Array.isArray(actual)) return actual.includes(String(rule.value));
      return String(actual ?? "") === String(rule.value ?? "");
    case "notEquals":
      if (Array.isArray(actual)) return !actual.includes(String(rule.value));
      return String(actual ?? "") !== String(rule.value ?? "");
    case "includes":
      if (Array.isArray(actual)) return actual.includes(String(rule.value));
      return String(actual ?? "").includes(String(rule.value ?? ""));
    default:
      return false;
  }
}

/** Whether a field should be visible given the current answers. */
export function isFieldVisible(field: LogicField, answers: AnswerMap): boolean {
  const logic = field.conditionalLogic;
  if (!logic || logic.rules.length === 0) return true;
  const results = logic.rules.map((rule) => ruleMatches(rule, answers));
  return logic.match === "all" ? results.every(Boolean) : results.some(Boolean);
}

/** Validate one visible field, returning an error message or null. */
export function validateField(field: LogicField, value: AnswerValue): string | null {
  const empty = field.type === "CHECKBOX" ? value !== true : isBlank(value);

  if (field.required && empty) {
    return field.type === "CHECKBOX" ? "This must be checked to continue." : "This field is required.";
  }
  if (empty) return null;

  if (field.type === "URL" && typeof value === "string") {
    try {
      new URL(value);
    } catch {
      return "Enter a valid URL (including https://).";
    }
  }
  if (field.type === "NUMBER" && typeof value === "string" && Number.isNaN(Number(value))) {
    return "Enter a number.";
  }
  return null;
}
