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

/**
 * Resolve the full conditional cascade shared by authoring, public submission,
 * speaker editing, imports, and server validation.
 *
 * Answers retained for a field that becomes hidden cannot keep a dependent
 * field visible (or hidden). Re-evaluate with hidden answers masked until the
 * visible key set settles. The pass count is bounded so malformed cycles never
 * loop forever.
 */
export function resolveVisibleFields<T extends LogicField>(
  fields: readonly T[],
  answers: Readonly<AnswerMap>,
): T[] {
  let visibleKeys = new Set(fields.map((field) => field.key));

  for (let pass = 0; pass <= fields.length; pass++) {
    const effective: AnswerMap = { ...answers };
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

/** URL fields represent browser links, not arbitrary URI schemes. */
export function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const parsed = new URL(value);
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/** Validate one visible field, returning an error message or null. */
export function validateField(field: LogicField, value: AnswerValue): string | null {
  const empty = field.type === "CHECKBOX" ? value !== true : isBlank(value);

  if (field.required && empty) {
    return field.type === "CHECKBOX" ? "This must be checked to continue." : "This field is required.";
  }
  if (empty) return null;

  if (field.type === "URL" && (typeof value !== "string" || !isHttpUrl(value))) {
    return "Enter a valid URL (including https://).";
  }
  if (field.type === "NUMBER") {
    const numeric = typeof value === "number" ? value : Number(value);
    if (typeof value === "boolean" || Array.isArray(value) || !Number.isFinite(numeric)) {
      return "Enter a number.";
    }
  }
  return null;
}
