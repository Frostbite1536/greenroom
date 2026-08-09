import { z } from "zod";
import { speakerTaskUpdateSchema } from "@/types/api";
import {
  toFormFieldSpecs,
  validateSubmissionContent,
  type FormSpec,
} from "@/lib/services/form-validation";
import type { FormAnswerValue } from "@/lib/services/types";

/**
 * Onboarding tasks that carry a form (requirements delta #2, answer 5 —
 * hotel stay and flight reimbursement are the director's must-have examples).
 *
 * The task form reuses the CFP form machinery end to end: the same
 * `FormConfig`/`FormField` rows, the same field renderer, and the same
 * content-validation function. That is deliberate — a second validator would
 * drift from the first, and B2's server-side conditional/type-aware rules land
 * in `validateSubmissionContent`, so this inherits them for free.
 */
export type TaskFormField = {
  id: string;
  key: string;
  label: string;
  helpText: string | null;
  type: string;
  required: boolean;
  options: { label: string; value: string }[] | null;
  conditionalLogic: unknown;
  sortOrder: number;
};

export type TaskResponses = Record<string, FormAnswerValue>;

/**
 * Body schema for the portal task update.
 *
 * Composed from the locked `speakerTaskUpdateSchema` rather than copied, so the
 * shared contract stays the single source of truth for status/artifact/notes and
 * this file only adds the responses map (`types/api.ts` is Architect-owned).
 */
const taskResponseValueSchema = z.union([
  z.string().max(5_000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(500)).max(50),
  z.null(),
]);

const taskResponsesSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9_]*$/), taskResponseValueSchema)
  .refine((responses) => Object.keys(responses).length <= 200, {
    message: "A task form cannot contain more than 200 answers.",
  });

export const taskUpdateWithResponsesSchema = speakerTaskUpdateSchema.extend({
  responses: taskResponsesSchema.optional(),
});

export type TaskUpdateWithResponses = z.infer<typeof taskUpdateWithResponsesSchema>;

/** Stored responses are untyped JSON; normalize before anything reads them. */
export function normalizeStoredResponses(value: unknown): TaskResponses {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, answer]) => taskResponseValueSchema.safeParse(answer).success),
  ) as TaskResponses;
}

/**
 * Merge stored answers with the ones being submitted.
 *
 * Same semantics as the R1 editor: only the keys you send are written, so a
 * partial save never wipes an answer the speaker gave earlier, and `null`
 * clears one deliberately.
 */
export function mergeTaskResponses(stored: unknown, incoming?: TaskResponses): TaskResponses {
  return { ...normalizeStoredResponses(stored), ...(incoming ?? {}) };
}

/** Only answers to fields that still exist on the form are kept. */
export function pruneToFields(responses: TaskResponses, fields: TaskFormField[]): TaskResponses {
  const known = new Set(fields.map((field) => field.key));
  return Object.fromEntries(Object.entries(responses).filter(([key]) => known.has(key)));
}

export type TaskFormValidationError = { code: string; message: string; fieldErrors?: Record<string, string[]> };

/**
 * Validate the answers a speaker is about to be marked complete on.
 *
 * Speaker counts do not apply to a task form, so the spec is normalized to
 * neutral bounds; everything else (required fields, and whatever B2 adds) comes
 * from the shared validator.
 */
export function validateTaskResponses(
  fields: TaskFormField[],
  responses: TaskResponses,
  options: {
    maxBioLength?: number;
    answerKeysToValidate?: readonly string[];
    requireComplete?: boolean;
  } = {},
): TaskFormValidationError | null {
  const requireComplete = options.requireComplete ?? true;
  const spec: FormSpec = {
    published: true,
    opensAt: null,
    closesAt: null,
    minSpeakers: 0,
    maxSpeakers: Number.MAX_SAFE_INTEGER,
    maxBioLength: options.maxBioLength ?? 5_000,
    // B2 owns parsing of stored option/conditional JSON. Reuse that exact
    // mapping here so task forms cannot drift from CFP validation.
    fields: toFormFieldSpecs(fields).map((field) => ({
      ...field,
      // Progress saves may be incomplete, but supplied values still have to
      // satisfy their type/options contract.
      required: requireComplete ? field.required : false,
    })),
  };
  return validateSubmissionContent(spec, {
    speakerCount: 1,
    answers: responses,
    answerKeysToValidate: options.answerKeysToValidate,
  });
}

/**
 * A form-carrying task can only be completed once its form is filled in.
 *
 * This is the point of the feature: "mark complete" on a hotel-stay task that
 * nobody filled in is exactly the false signal the director is trying to
 * eliminate. Any other status (going back to in-progress) stays free.
 */
export function completionBlocked(input: {
  hasForm: boolean;
  nextStatus: string;
  fields: TaskFormField[];
  responses: TaskResponses;
  answerKeysToValidate?: readonly string[];
  maxBioLength?: number;
}): TaskFormValidationError | null {
  if (!input.hasForm) return null;
  return validateTaskResponses(input.fields, input.responses, {
    answerKeysToValidate: input.answerKeysToValidate,
    maxBioLength: input.maxBioLength,
    requireComplete: input.nextStatus === "COMPLETED",
  });
}
