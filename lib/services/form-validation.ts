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
 * Validate a submission attempt. `now` is injectable for deterministic tests.
 * Draft saves bypass window/required checks (see `submissionAllowsDraft`).
 */
export function validateSubmission(
  form: FormSpec,
  input: SubmissionInput,
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

  for (const field of form.fields) {
    if (field.required && isEmpty(input.answers[field.key])) {
      (fieldErrors[field.key] ??= []).push(`${field.label} is required.`);
    }
  }

  const bioKey =
    input.bioFieldKey ?? form.fields.find((f) => BIO_KEYS.has(f.key))?.key ?? null;
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
