/**
 * Server-side validation of CFP form *shape* writes (C4 / D-C5-2).
 *
 * `lib/services/form-config.ts` already protects answers that exist (duplicate
 * keys, destructive edits). This module protects the form itself: a payload can
 * be perfectly well-typed by `formConfigInputSchema` and still describe a form
 * nobody can ever fill in — a rule pointing at a question that was deleted in
 * the same save, two questions waiting on each other, a choice with no stored
 * value. Those saves used to succeed and only broke later, in front of a
 * submitter.
 *
 * Everything here is pure and payload-only, so the builder can import the same
 * inventory and mirror the same refusals. The server stays authoritative: the
 * UI mirroring this is a convenience, never the enforcement.
 */

/** The operator allowlist shared with `lib/form-logic.ts`'s evaluator. */
export const LOGIC_OPERATORS = ["isEmpty", "isNotEmpty", "equals", "notEquals", "includes"] as const;
export type LogicOperator = (typeof LOGIC_OPERATORS)[number];

/** Operators that compare against a value, so a value is mandatory. */
const VALUE_OPERATORS: readonly LogicOperator[] = ["equals", "notEquals", "includes"];

/** Operators that only ask whether an answer exists. */
const PRESENCE_OPERATORS: readonly LogicOperator[] = ["isEmpty", "isNotEmpty"];

/** Field types whose answers are drawn from a stored option list. */
const OPTION_BACKED_TYPES: ReadonlySet<string> = new Set(["SELECT", "MULTI_SELECT"]);

const OPERATOR_WORDS: Record<LogicOperator, string> = {
  isEmpty: "is empty",
  isNotEmpty: "is not empty",
  equals: "is",
  notEquals: "is not",
  includes: "contains",
};

export type BuiltInSubmissionSource = {
  /** The key a `LogicRule.fieldKey` uses, matching the submission payload. */
  key: string;
  /** The wording a submitter sees, for error messages and builder menus. */
  label: string;
  /** Operators that can produce a satisfiable rule against this source. */
  operators: readonly LogicOperator[];
  /**
   * A closed value set the server itself enforces at submission time, when one
   * exists. Left undefined means "the key is real, the values are not knowable
   * here" — see the note below. Never populate this from a client-only picker.
   */
  values?: readonly string[];
};

/**
 * The built-in questions every CFP submission carries, derived from the inputs
 * `components/cfp-form.tsx` renders itself rather than from `form.fields`:
 * Session title (`cfp-title`), Abstract (`cfp-abstract`), Session format
 * (`cfp-format`), Topic category (`cfp-category`) and the speaker roster on the
 * Participants step. Keys match the submission payload `buildPayload()` sends,
 * so a rule and an answer always name the same thing.
 *
 * No built-in declares `values` today, deliberately:
 *
 * - **Format** looks closed in the picker, but the server accepts any string
 *   (`types/api.ts` `format: z.string().trim().max(80)`), and the seeded
 *   catalogue already stores different wording ("Talk (30 min)") from the
 *   picker's ("Talk"). Refusing a rule on a value the server happily stores
 *   would be a false refusal, so only the key is checked.
 * - **Topic category** is event-scoped data: its values are Category ids that
 *   are created and deleted after a form is saved, so any set captured at
 *   shape-write time would go stale and start refusing legitimate edits.
 *
 * The `values` slot stays in the type so the check switches on for free if a
 * built-in ever becomes a server-enforced closed set.
 */
export const BUILT_IN_SUBMISSION_SOURCES: readonly BuiltInSubmissionSource[] = [
  { key: "title", label: "Session title", operators: LOGIC_OPERATORS },
  { key: "abstract", label: "Abstract", operators: LOGIC_OPERATORS },
  { key: "format", label: "Session format", operators: LOGIC_OPERATORS },
  { key: "categoryId", label: "Topic category", operators: LOGIC_OPERATORS },
  // A roster of people, not one answer: only its presence can be compared.
  { key: "speakers", label: "Speakers", operators: PRESENCE_OPERATORS },
];

/** Keys a custom question may not claim, because a built-in already owns them. */
export const RESERVED_FIELD_KEYS: readonly string[] = BUILT_IN_SUBMISSION_SOURCES.map(
  (source) => source.key,
);

export type FormShapeIssueCode =
  | "FORM_FIELD_KEY_RESERVED"
  | "FORM_OPTION_VALUE_EMPTY"
  | "FORM_OPTION_VALUE_DUPLICATE"
  | "FORM_LOGIC_SOURCE_UNKNOWN"
  | "FORM_LOGIC_OPERATOR_UNSUPPORTED"
  | "FORM_LOGIC_VALUE_MISSING"
  | "FORM_LOGIC_VALUE_NOT_AN_OPTION"
  | "FORM_LOGIC_CYCLE";

export type FormShapeIssue = {
  code: FormShapeIssueCode;
  /** The payload question key the operator has to fix. */
  fieldKey: string;
  /** Plain language, in the register `describeDestructiveChange` uses. */
  message: string;
};

export type ShapeFieldOption = { label?: string | null; value: string };

export type ShapeFieldLogic = {
  match: "all" | "any";
  rules: readonly { fieldKey: string; operator: string; value?: string | number | boolean }[];
};

/** The slice of an incoming field this module needs. */
export type ShapeField = {
  key: string;
  label?: string | null;
  type: string;
  options?: readonly ShapeFieldOption[] | null;
  conditionalLogic?: ShapeFieldLogic | null;
};

function quote(text: string): string {
  return `“${text}”`;
}

function fieldName(field: ShapeField): string {
  const label = field.label?.trim();
  return label && label.length > 0 ? label : field.key;
}

function optionName(option: ShapeFieldOption): string {
  const label = option.label?.trim();
  return label && label.length > 0 ? quote(label) : "An unnamed choice";
}

/** A rule value the author never actually filled in. */
function isMissingValue(value: string | number | boolean | undefined): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "string" && value.trim().length === 0;
}

function isLogicOperator(operator: string): operator is LogicOperator {
  return (LOGIC_OPERATORS as readonly string[]).includes(operator);
}

/**
 * Every rule source a payload may point at, as a menu the builder can render
 * and an error message can quote back.
 */
export function describeAvailableSources(
  fields: readonly ShapeField[],
  builtIns: readonly BuiltInSubmissionSource[] = BUILT_IN_SUBMISSION_SOURCES,
): string[] {
  return [...builtIns.map((source) => source.label), ...fields.map(fieldName)];
}

type SourceView = {
  label: string;
  operators: readonly LogicOperator[];
  /** Allowed values, or null when values are not checkable for this source. */
  values: readonly string[] | null;
};

function builtInView(source: BuiltInSubmissionSource): SourceView {
  return {
    label: source.label,
    operators: source.operators,
    values: source.values && source.values.length > 0 ? source.values : null,
  };
}

function customView(field: ShapeField): SourceView {
  // Only an option-backed question that actually carries options has a value
  // set. A half-built SELECT with no options yet must not make every rule on it
  // impossible — the builder saves work in progress.
  // Compare against the value exactly as it will be stored, because that is
  // what `lib/form-logic.ts` compares at submission time. Blank ones are
  // refused separately and would otherwise widen the set.
  const values = OPTION_BACKED_TYPES.has(field.type)
    ? (field.options ?? []).map((option) => option.value).filter((value) => value.trim().length > 0)
    : [];
  return {
    label: fieldName(field),
    operators: LOGIC_OPERATORS,
    values: values.length > 0 ? values : null,
  };
}

/**
 * Every reason this form shape could not work, in payload order: reserved keys
 * and option problems per question, then each question's rules, then dependency
 * cycles. Empty means the shape is sound.
 *
 * Duplicate keys are the caller's existing check (`findDuplicateFieldKeys`); if
 * any slip through, the last occurrence wins here and the duplicate refusal
 * still fires first at the route.
 */
export function findFormShapeIssues(
  fields: readonly ShapeField[],
  options: { builtInSources?: readonly BuiltInSubmissionSource[] } = {},
): FormShapeIssue[] {
  const builtIns = options.builtInSources ?? BUILT_IN_SUBMISSION_SOURCES;
  const builtInByKey = new Map(builtIns.map((source) => [source.key, source]));
  const fieldByKey = new Map(fields.map((field) => [field.key, field]));
  const issues: FormShapeIssue[] = [];

  for (const field of fields) {
    const name = quote(fieldName(field));

    const reserved = builtInByKey.get(field.key);
    if (reserved) {
      issues.push({
        code: "FORM_FIELD_KEY_RESERVED",
        fieldKey: field.key,
        message:
          `${name} uses the reserved name ${quote(field.key)}, which already belongs to the ` +
          `built-in ${quote(reserved.label)} question on every submission. Give this question a different key.`,
      });
    }

    // Option discipline. Answers are stored by value, so a value has to exist
    // and has to be unique — and it is never derived from the wording, which
    // stays free to reword at any time.
    const seenValues = new Map<string, ShapeFieldOption>();
    for (const option of field.options ?? []) {
      const trimmed = option.value.trim();
      if (trimmed.length === 0) {
        issues.push({
          code: "FORM_OPTION_VALUE_EMPTY",
          fieldKey: field.key,
          message:
            `${optionName(option)} in ${name} has no stored value, so nobody could ever pick it. ` +
            `Give every choice a value of its own.`,
        });
        continue;
      }
      if (seenValues.has(trimmed)) {
        issues.push({
          code: "FORM_OPTION_VALUE_DUPLICATE",
          fieldKey: field.key,
          message:
            `Two choices in ${name} share the stored value ${quote(trimmed)}. Answers are saved by ` +
            `value, so each choice needs its own — they can still read the same way to submitters.`,
        });
        continue;
      }
      seenValues.set(trimmed, option);
    }

    for (const rule of field.conditionalLogic?.rules ?? []) {
      const source = builtInByKey.has(rule.fieldKey)
        ? builtInView(builtInByKey.get(rule.fieldKey)!)
        : fieldByKey.has(rule.fieldKey)
          ? customView(fieldByKey.get(rule.fieldKey)!)
          : null;

      if (!source) {
        issues.push({
          code: "FORM_LOGIC_SOURCE_UNKNOWN",
          fieldKey: field.key,
          message:
            `${name} is set to appear based on ${quote(rule.fieldKey)}, but this form has no such ` +
            `question. Point the rule at a question on this form, or at one of the built-in ones: ` +
            `${builtIns.map((entry) => quote(entry.label)).join(", ")}.`,
        });
        continue;
      }

      if (!isLogicOperator(rule.operator)) {
        issues.push({
          code: "FORM_LOGIC_OPERATOR_UNSUPPORTED",
          fieldKey: field.key,
          message:
            `${name} has a rule with a condition this form cannot run (${quote(rule.operator)}). ` +
            `Use one of: ${LOGIC_OPERATORS.map((entry) => quote(OPERATOR_WORDS[entry])).join(", ")}.`,
        });
        continue;
      }

      if (!source.operators.includes(rule.operator)) {
        issues.push({
          code: "FORM_LOGIC_OPERATOR_UNSUPPORTED",
          fieldKey: field.key,
          message:
            `${name} can only be shown based on whether ${quote(source.label)} is filled in or not, ` +
            `because that question has no single answer to compare. Use ` +
            `${quote(OPERATOR_WORDS.isEmpty)} or ${quote(OPERATOR_WORDS.isNotEmpty)}.`,
        });
        continue;
      }

      if (PRESENCE_OPERATORS.includes(rule.operator)) continue;

      if (VALUE_OPERATORS.includes(rule.operator) && isMissingValue(rule.value)) {
        issues.push({
          code: "FORM_LOGIC_VALUE_MISSING",
          fieldKey: field.key,
          message:
            `${name} has a rule on ${quote(source.label)} with nothing to compare against. Pick the ` +
            `answer the rule should look for, or switch it to ${quote(OPERATOR_WORDS.isEmpty)} or ` +
            `${quote(OPERATOR_WORDS.isNotEmpty)}.`,
        });
        continue;
      }

      const wanted = String(rule.value);
      if (source.values && !source.values.includes(wanted)) {
        issues.push({
          code: "FORM_LOGIC_VALUE_NOT_AN_OPTION",
          fieldKey: field.key,
          message:
            `${name} has a rule looking for ${quote(wanted)} in ${quote(source.label)}, but that is ` +
            `not one of its choices (${source.values.map(quote).join(", ")}). Rules match the stored ` +
            `value, not the wording shown to submitters.`,
        });
      }
    }
  }

  issues.push(...findLogicCycles(fields, builtInByKey));
  return issues;
}

/**
 * Dependency cycles among custom questions, including a question that waits on
 * itself. Built-in sources are terminal — nothing can make them depend on a
 * question — so they are simply not nodes.
 *
 * Iterative depth-first search: a payload's field count is not bounded by the
 * schema, so the traversal must not ride the call stack.
 */
function findLogicCycles(
  fields: readonly ShapeField[],
  builtInByKey: ReadonlyMap<string, BuiltInSubmissionSource>,
): FormShapeIssue[] {
  const fieldByKey = new Map(fields.map((field) => [field.key, field]));
  const dependencies = new Map<string, string[]>();
  for (const field of fields) {
    const seen = new Set<string>();
    const deps: string[] = [];
    for (const rule of field.conditionalLogic?.rules ?? []) {
      const key = rule.fieldKey;
      if (builtInByKey.has(key) || !fieldByKey.has(key) || seen.has(key)) continue;
      seen.add(key);
      deps.push(key);
    }
    dependencies.set(field.key, deps);
  }

  const OPEN = 1;
  const DONE = 2;
  const state = new Map<string, 1 | 2>();
  const path: string[] = [];
  const reported = new Set<string>();
  const issues: FormShapeIssue[] = [];

  // Payload position per key, precomputed once: reporting a large cycle must
  // not rescan the unbounded fields array per member inside the write
  // transaction (Greptile PR #64).
  const orderByKey = new Map(fields.map((field, index) => [field.key, index]));
  const report = (cycle: readonly string[]) => {
    // Rotate to the payload-earliest member so the same loop reports once,
    // whichever question the traversal happened to enter it from.
    let pivot = 0;
    for (let index = 1; index < cycle.length; index++) {
      const current = orderByKey.get(cycle[index]) ?? -1;
      const best = orderByKey.get(cycle[pivot]) ?? -1;
      if (current < best) pivot = index;
    }
    const rotated = [...cycle.slice(pivot), ...cycle.slice(0, pivot)];
    const signature = rotated.join(">");
    if (reported.has(signature)) return;
    reported.add(signature);

    const owner = rotated[0];
    const name = quote(fieldName(fieldByKey.get(owner)!));
    if (rotated.length === 1) {
      issues.push({
        code: "FORM_LOGIC_CYCLE",
        fieldKey: owner,
        message:
          `${name} is set to appear based on its own answer, which can never happen. Base the rule ` +
          `on a different question.`,
      });
      return;
    }
    const chain = [...rotated, owner]
      .map((key) => quote(fieldName(fieldByKey.get(key)!)))
      .join(" → ");
    issues.push({
      code: "FORM_LOGIC_CYCLE",
      fieldKey: owner,
      message:
        `These questions wait on each other in a loop: ${chain}. None of them can ever be shown ` +
        `until one stops depending on the others.`,
    });
  };

  for (const field of fields) {
    if (state.has(field.key)) continue;
    state.set(field.key, OPEN);
    path.push(field.key);
    const stack: { key: string; next: number }[] = [{ key: field.key, next: 0 }];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const deps = dependencies.get(frame.key) ?? [];
      if (frame.next < deps.length) {
        const dep = deps[frame.next++];
        const seen = state.get(dep);
        if (seen === OPEN) {
          report(path.slice(path.indexOf(dep)));
        } else if (seen === undefined) {
          state.set(dep, OPEN);
          path.push(dep);
          stack.push({ key: dep, next: 0 });
        }
        continue;
      }
      state.set(frame.key, DONE);
      path.pop();
      stack.pop();
    }
  }

  return issues;
}

/** Group issues the way `ApiError.fieldErrors` is consumed: by question key. */
export function formShapeFieldErrors(
  issues: readonly FormShapeIssue[],
): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of issues) {
    (fieldErrors[issue.fieldKey] ??= []).push(issue.message);
  }
  return fieldErrors;
}
