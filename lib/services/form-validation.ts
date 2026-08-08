import type { ConditionalLogic } from "@/lib/form-logic";
import {
  parseConditionalLogic,
  parseFieldOptions,
  resolveVisibleFields,
  validateAnswerType,
  type FieldOption,
} from "@/lib/services/field-visibility";
import type { FormAnswerValue } from "@/lib/services/types";

/**
 * Server-side enforcement of public-submission constraints (INV-FORM-001):
 * publication + window, speaker-count, required fields, and bio length. Pure so
 * it can be unit-tested without a database; the route supplies live form state.
 */
export type FormFieldSpec = {
  key: string;
  label: string;
  type: string;
  required: boolean;
  /** Allowed values for SELECT/MULTI_SELECT; answers outside them are refused. */
  options?: FieldOption[] | null;
  /** When present, the field is only asked while these rules match (WAVE1-B2). */
  conditionalLogic?: ConditionalLogic | null;
};

export type FormSpec = {
  published: boolean;
  opensAt: Date | null;
  closesAt: Date | null;
  minSpeakers: number;
  maxSpeakers: number;
  maxBioLength: number;
  fields: FormFieldSpec[];
};

/**
 * Map stored form fields onto the validation spec, parsing the JSON columns.
 * Shared by the public submission route and the speaker edit route so the two
 * cannot end up enforcing different rules on the same form.
 */
export function toFormFieldSpecs(
  fields: readonly {
    key: string;
    label: string;
    type: string;
    required: boolean;
    options?: unknown;
    conditionalLogic?: unknown;
  }[],
): FormFieldSpec[] {
  return fields.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    options: parseFieldOptions(field.options),
    conditionalLogic: parseConditionalLogic(field.conditionalLogic),
  }));
}

export type SubmissionInput = {
  speakerCount: number;
  answers: Record<string, FormAnswerValue>;
  /** Field key treated as the speaker bio for max-length enforcement. */
  bioFieldKey?: string;
};

export type FormValidationError = {
  code: string;
  message: string;
  fieldErrors?: Record<string, string[]>;
};

const BIO_KEYS = new Set(["bio", "speaker_bio", "biography"]);

function isEmpty(value: FormAnswerValue): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Publication + window gate: may a *new* submission be accepted right now?
 *
 * Split out from `validateSubmission` so the authenticated speaker-edit path
 * can reuse the content rules below without it. An accepted speaker normally
 * edits long after the CFP window closed, and the competition lead confirmed
 * edit-lock windows are not used, so the window governs new submissions only.
 */
export function validateSubmissionWindow(
  form: FormSpec,
  now: Date = new Date(),
): FormValidationError | null {
  if (!form.published) {
    return { code: "FORM_UNPUBLISHED", message: "This form is not accepting submissions." };
  }
  if (form.opensAt && now < form.opensAt) {
    return { code: "FORM_NOT_OPEN", message: "Submissions have not opened yet." };
  }
  if (form.closesAt && now >= form.closesAt) {
    return { code: "FORM_CLOSED", message: "The submission window has closed." };
  }
  return null;
}

/**
 * Content rules (INV-FORM-001): speaker counts, required fields, bio length.
 * Shared verbatim by public submission and by authorized speaker edits so the
 * two paths can never drift apart.
 */
export function validateSubmissionContent(
  form: FormSpec,
  input: SubmissionInput,
): FormValidationError | null {
  if (input.speakerCount < form.minSpeakers) {
    return {
      code: "TOO_FEW_SPEAKERS",
      message: `At least ${form.minSpeakers} speaker(s) required.`,
      fieldErrors: { speakers: [`Add at least ${form.minSpeakers} speaker(s).`] },
    };
  }
  if (input.speakerCount > form.maxSpeakers) {
    return {
      code: "TOO_MANY_SPEAKERS",
      message: `At most ${form.maxSpeakers} speaker(s) allowed.`,
      fieldErrors: { speakers: [`Remove speakers to stay within ${form.maxSpeakers}.`] },
    };
  }

  const fieldErrors: Record<string, string[]> = {};

  // Only fields the submitter was actually asked are enforced. The renderer
  // sends answers for visible fields only, so requiring a conditionally hidden
  // field would reject a perfectly valid submission (audit2#3).
  const visible = resolveVisibleFields(form.fields, input.answers);

  for (const field of visible) {
    const value = input.answers[field.key];
    // A required checkbox means "must be ticked", not merely "answered".
    const missing = field.type === "CHECKBOX" ? value !== true : isEmpty(value);
    if (field.required && missing) {
      (fieldErrors[field.key] ??= []).push(
        field.type === "CHECKBOX"
          ? `${field.label} must be ticked.`
          : `${field.label} is required.`,
      );
      continue;
    }
    const typeError = validateAnswerType(field, value);
    if (typeError) (fieldErrors[field.key] ??= []).push(typeError);
  }

  const bioKey =
    input.bioFieldKey ?? visible.find((f) => BIO_KEYS.has(f.key))?.key ?? null;
  if (bioKey) {
    const value = input.answers[bioKey];
    if (typeof value === "string" && value.length > form.maxBioLength) {
      (fieldErrors[bioKey] ??= []).push(
        `Keep this under ${form.maxBioLength} characters (currently ${value.length}).`,
      );
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { code: "FIELD_ERRORS", message: "Please fix the highlighted fields.", fieldErrors };
  }

  return null;
}

/**
 * Validate a public submission attempt: window gate, then content rules.
 * `now` is injectable for deterministic tests. Draft saves bypass this entirely
 * (the route only calls it for `intent: "submit"`).
 */
export function validateSubmission(
  form: FormSpec,
  input: SubmissionInput,
  now: Date = new Date(),
): FormValidationError | null {
  return validateSubmissionWindow(form, now) ?? validateSubmissionContent(form, input);
}
