/**
 * Pure helpers behind the form builder's option list and rule editor.
 *
 * The server contract lives in `lib/services/form-shape-validation.ts`; this
 * module imports its inventory rather than repeating it, and never decides
 * whether a form is acceptable — `findFormShapeIssues` does, on both sides.
 * What lives here is the authoring behaviour the contract implies: how a new
 * choice gets a value that survives being relabelled, which sources a rule may
 * point at, and which of them can answer a given comparison.
 */
import {
  BUILT_IN_SUBMISSION_SOURCES,
  LOGIC_OPERATORS,
  type LogicOperator,
} from "@/lib/services/form-shape-validation";

/** Structural, so this stays free of the Prisma-backed read module. */
export type BuilderOption = { label: string; value: string };

/**
 * Operators the builder must collect a value for. Derived from the shared
 * allowlist so a new operator cannot be silently forgotten here; the refusal
 * itself is still `FORM_LOGIC_VALUE_MISSING` from the shared validator.
 */
export const PRESENCE_OPERATORS: readonly LogicOperator[] = ["isEmpty", "isNotEmpty"];
export const VALUE_BEARING_OPERATORS: readonly LogicOperator[] = LOGIC_OPERATORS.filter(
  (operator) => !PRESENCE_OPERATORS.includes(operator),
);

export function operatorNeedsValue(operator: string): boolean {
  return (VALUE_BEARING_OPERATORS as readonly string[]).includes(operator);
}

/** The wording each operator gets in the builder's picker. */
export const OPERATOR_LABELS: Record<LogicOperator, string> = {
  equals: "is",
  notEquals: "is not",
  includes: "contains",
  isNotEmpty: "is answered",
  isEmpty: "is empty",
};

// ---- option values --------------------------------------------------------

const GENERATED_VALUE_PREFIX = "option_";

/**
 * A stable value for a brand-new choice.
 *
 * Deliberately not derived from the label: answers are stored by value, so a
 * value that tracks its wording silently orphans every answer already given and
 * every rule already pointing at it. Counting from the existing list (rather
 * than from a timestamp or random suffix) keeps this deterministic, so the same
 * edit produces the same payload and server rendering matches the client's.
 */
export function nextOptionValue(existing: readonly BuilderOption[]): string {
  const taken = new Set(existing.map((option) => option.value.trim()));
  for (let n = existing.length + 1; ; n++) {
    const candidate = `${GENERATED_VALUE_PREFIX}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function addOption(existing: readonly BuilderOption[], label = ""): BuilderOption[] {
  return [...existing, { label, value: nextOptionValue(existing) }];
}

/** Relabelling touches the wording only — never the stored value. */
export function relabelOption(
  existing: readonly BuilderOption[],
  index: number,
  label: string,
): BuilderOption[] {
  return existing.map((option, i) => (i === index ? { ...option, label } : option));
}

export function removeOption(existing: readonly BuilderOption[], index: number): BuilderOption[] {
  return existing.filter((_, i) => i !== index);
}

/**
 * Bring a legacy line-per-label option list up to the value discipline without
 * changing anything already stored: existing entries keep their value, and only
 * a genuinely new line gets a generated one.
 */
export function normalizeOptions(options: readonly BuilderOption[] | null | undefined): BuilderOption[] {
  const result: BuilderOption[] = [];
  for (const option of options ?? []) {
    const value = (option?.value ?? "").trim();
    result.push({
      label: option?.label ?? "",
      value: value.length > 0 ? value : nextOptionValue(result),
    });
  }
  return result;
}

// ---- rule sources ---------------------------------------------------------

export type RuleSourceField = {
  key: string;
  label: string;
  type: string;
  options?: readonly BuilderOption[] | null;
};

export type RuleSource = {
  key: string;
  label: string;
  builtIn: boolean;
  operators: readonly LogicOperator[];
  /** The values a picker may offer, or null when the value is free text. */
  optionValues: readonly BuilderOption[] | null;
};

const OPTION_BACKED_TYPES: ReadonlySet<string> = new Set(["SELECT", "MULTI_SELECT"]);

/**
 * Which comparisons the builder will let an author write against a *built-in*
 * source. A deliberate narrowing of the server's allowlist, not a fork of it.
 *
 * At submission time `validateSubmissionContent` resolves visibility from the
 * custom-field answers alone, so every built-in reads as unanswered there. That
 * makes `isEmpty` and `notEquals` server-true and client-false: the submitter
 * would never be shown the field, and the server would then refuse the
 * submission for not answering it — an error with nothing the submitter can do.
 * The three operators kept here are server-false for an unanswered built-in, so
 * the worst case is the opposite and harmless one: a field the client showed is
 * simply not required server-side.
 *
 * The narrowing disappears the moment submission-time validation folds built-in
 * answers in (backend lane); this list is the only place to delete.
 */
const BUILT_IN_AUTHORABLE_OPERATORS: readonly LogicOperator[] = ["isNotEmpty", "equals", "includes"];

/**
 * Every source a rule on `field` may name: the built-in submission questions the
 * server declares, then the other questions on this same form. Self-reference is
 * excluded because it can only ever produce `FORM_LOGIC_CYCLE`.
 */
export function ruleSources(
  fields: readonly RuleSourceField[],
  selfKey: string | null,
  builtInValues: Readonly<Record<string, readonly BuilderOption[]>> = {},
): RuleSource[] {
  const builtIns = BUILT_IN_SUBMISSION_SOURCES.map<RuleSource>((source) => ({
    key: source.key,
    label: source.label,
    builtIn: true,
    operators: source.operators.filter((operator) =>
      BUILT_IN_AUTHORABLE_OPERATORS.includes(operator),
    ),
    optionValues: builtInValues[source.key] ?? null,
  })).filter((source) => source.operators.length > 0);
  const custom = fields
    .filter((field) => field.key !== selfKey)
    .map<RuleSource>((field) => ({
      key: field.key,
      label: field.label.trim().length > 0 ? field.label : field.key,
      builtIn: false,
      operators: LOGIC_OPERATORS,
      optionValues:
        OPTION_BACKED_TYPES.has(field.type) && (field.options ?? []).length > 0
          ? (field.options ?? [])
          : null,
    }));
  return [...builtIns, ...custom];
}

export function findRuleSource(sources: readonly RuleSource[], key: string): RuleSource | null {
  return sources.find((source) => source.key === key) ?? null;
}

/**
 * A rule that is already valid the moment it is added.
 *
 * The old builder seeded `{ operator: "equals", value: "" }`, which the server
 * now refuses with `FORM_LOGIC_VALUE_MISSING` the first time the author hits
 * Save — a papercut with no way to see it coming. Seeding a presence operator
 * needs no value, so a freshly added rule saves as-is and the author opts into
 * a comparison when they have one.
 */
export function defaultRule(source: RuleSource): {
  fieldKey: string;
  operator: LogicOperator;
  value?: string;
} {
  const operator: LogicOperator = source.operators.includes("isNotEmpty")
    ? "isNotEmpty"
    : source.operators[0];
  return operatorNeedsValue(operator)
    ? { fieldKey: source.key, operator, value: source.optionValues?.[0]?.value ?? "" }
    : { fieldKey: source.key, operator };
}

/**
 * Re-point an existing rule at a different source, keeping what still makes
 * sense: an operator the new source cannot answer falls back, and a value that
 * is not one of the new source's choices is dropped rather than saved as a
 * refusal waiting to happen.
 */
export function retargetRule(
  rule: { fieldKey: string; operator: string; value?: string | number | boolean },
  source: RuleSource,
): { fieldKey: string; operator: string; value?: string | number | boolean } {
  const operator = (source.operators as readonly string[]).includes(rule.operator)
    ? rule.operator
    : defaultRule(source).operator;
  if (!operatorNeedsValue(operator)) return { fieldKey: source.key, operator };
  const current = rule.value === undefined ? "" : String(rule.value);
  const allowed = source.optionValues;
  const value =
    allowed && !allowed.some((option) => option.value === current)
      ? (allowed[0]?.value ?? "")
      : current;
  return { fieldKey: source.key, operator, value };
}
