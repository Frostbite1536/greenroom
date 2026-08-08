/**
 * Client-side conditional-logic evaluation for form fields.
 *
 * Mirrors the `conditionalLogic` contract in `types/api.ts`. Used by both the
 * form builder preview and the public CFP renderer so visibility rules behave
 * identically in authoring and submission.
 */
import type { ConditionalLogic, FormFieldModel } from "@/lib/fixtures";

export type AnswerValue = string | number | boolean | string[] | null | undefined;
export type AnswerMap = Record<string, AnswerValue>;

function ruleMatches(
  rule: ConditionalLogic["rules"][number],
  answers: AnswerMap,
): boolean {
  const actual = answers[rule.fieldKey];
  switch (rule.operator) {
    case "isEmpty":
      return actual === undefined || actual === null || actual === "" || (Array.isArray(actual) && actual.length === 0);
    case "isNotEmpty":
      return !(actual === undefined || actual === null || actual === "" || (Array.isArray(actual) && actual.length === 0));
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
export function isFieldVisible(field: FormFieldModel, answers: AnswerMap): boolean {
  const logic = field.conditionalLogic;
  if (!logic || logic.rules.length === 0) return true;
  const results = logic.rules.map((rule) => ruleMatches(rule, answers));
  return logic.match === "all" ? results.every(Boolean) : results.some(Boolean);
}

/** Validate a single visible field, returning an error string or null. */
export function validateField(field: FormFieldModel, value: AnswerValue): string | null {
  const empty =
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (field.type === "CHECKBOX" && value !== true);

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
  if (field.type === "NUMBER" && typeof value === "string" && value !== "" && Number.isNaN(Number(value))) {
    return "Enter a number.";
  }
  return null;
}
