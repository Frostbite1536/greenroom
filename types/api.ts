import { z } from "zod";
import { isIanaTimeZone } from "@/lib/tz";

// NOTE: relaxed from z.string().cuid() by the backend worker to accept the
// seeded demo ids (e.g. event id "demo-event") that are not cuids. Entity ids
// are server-generated cuids; cross-event access is guarded server-side, not by
// id format. See $SPRINT_COORDINATION_DIR/requests/backend-idschema-relax.md.
export const idSchema = z.string().min(1).max(191);
export const abstractStatusSchema = z.enum([
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "MAYBE",
  "ACCEPTED",
  "REJECTED",
  "WITHDRAWN",
]);
export const formFieldTypeSchema = z.enum([
  "SHORT_TEXT",
  "LONG_TEXT",
  "NUMBER",
  "SELECT",
  "MULTI_SELECT",
  "CHECKBOX",
  "URL",
]);

export const conditionalRuleSchema = z.object({
  fieldKey: z.string().min(1),
  operator: z.enum(["equals", "notEquals", "includes", "isEmpty", "isNotEmpty"]),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export const formFieldInputSchema = z.object({
  id: idSchema.optional(),
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1).max(160),
  helpText: z.string().max(500).optional(),
  type: formFieldTypeSchema,
  required: z.boolean().default(false),
  options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  conditionalLogic: z
    .object({
      match: z.enum(["all", "any"]),
      rules: z.array(conditionalRuleSchema).min(1),
    })
    .optional(),
  sortOrder: z.number().int().nonnegative(),
});

export const formConfigInputSchema = z
  .object({
    eventId: idSchema,
    id: idSchema.optional(),
    name: z.string().trim().min(1).max(160),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    welcomeText: z.string().max(5000).optional(),
    thankYouText: z.string().max(5000).optional(),
    opensAt: z.string().datetime().optional(),
    closesAt: z.string().datetime().optional(),
    submissionLimit: z.number().int().positive().optional(),
    minSpeakers: z.number().int().min(1).max(20),
    maxSpeakers: z.number().int().min(1).max(20),
    maxBioLength: z.number().int().min(100).max(10_000),
    published: z.boolean(),
    fields: z.array(formFieldInputSchema),
  })
  .refine((form) => form.minSpeakers <= form.maxSpeakers, {
    message: "maxSpeakers must be at least minSpeakers",
    path: ["maxSpeakers"],
  })
  .refine(
    (form) => !form.opensAt || !form.closesAt || new Date(form.opensAt) < new Date(form.closesAt),
    { message: "closesAt must be after opensAt", path: ["closesAt"] },
  );

export const formAnswerValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.null(),
]);

/**
 * How a person contributes to one proposal — "Co-presenter", "Panellist".
 * Free text because a programme team's vocabulary is its own, bounded because
 * it renders on a public speaker list, and blank normalizes to an explicit
 * absence so an empty box never becomes an empty label.
 */
export const speakerRoleSchema = z
  .string()
  .trim()
  .max(80)
  .optional()
  .transform((value) => (value ? value : null));

export const coSpeakerInputSchema = z
  .array(
    z.object({
      email: z.string().trim().toLowerCase().email(),
      name: z.string().trim().min(1).max(120),
      isPrimary: z.boolean().default(false),
      role: speakerRoleSchema,
    }),
  )
  .min(1)
  .max(20);

export const categoryInputSchema = z.object({
  eventId: idSchema,
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  defaultTeamKey: z.string().trim().max(120).optional(),
  sortOrder: z.number().int().nonnegative().default(0),
});

const eventDateKeySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }, "Use a real calendar date.");

/** Minimal, current-event-only settings update. Event creation/deletion stays out of M5. */
export const eventSettingsUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    timezone: z.string().trim().min(1).max(100).refine(isIanaTimeZone, "Use a valid IANA timezone.").optional(),
    startsOn: eventDateKeySchema.nullable().optional(),
    endsOn: eventDateKeySchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const datesProvided = value.startsOn !== undefined || value.endsOn !== undefined;
    if (!value.name && !value.timezone && !datesProvided) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: "Provide at least one setting to update." });
    }
    if (datesProvided && (value.startsOn === undefined || value.endsOn === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["startsOn"], message: "Provide both event dates together." });
      return;
    }
    if ((value.startsOn === null) !== (value.endsOn === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endsOn"], message: "Clear both event dates together." });
    }
    if (value.startsOn && value.endsOn && value.startsOn > value.endsOn) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endsOn"], message: "The event must end on or after its start date." });
    }
  });

const roomNameSchema = z.string().trim().min(1).max(120);
const roomCapacitySchema = z.number().int().positive().max(1_000_000).nullable();
const roomSortOrderSchema = z.number().int().nonnegative().max(100_000);

export const roomCreateSchema = z
  .object({
    name: roomNameSchema,
    capacity: roomCapacitySchema.optional(),
    sortOrder: roomSortOrderSchema.optional(),
  })
  .strict();

export const roomUpdateSchema = z
  .object({
    id: idSchema,
    name: roomNameSchema.optional(),
    capacity: roomCapacitySchema.optional(),
    sortOrder: roomSortOrderSchema.optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.capacity !== undefined || value.sortOrder !== undefined, {
    message: "Provide at least one room field to update.",
  });

/**
 * Onboarding-task templates (CNT-01/SPK-05).
 *
 * A deadline is authored as an event-local calendar day (`dueOn`) and stored as
 * the instant that day ends in the event's own timezone. That is the convention
 * the seeded checklist already uses, so a due date never moves a day because of
 * the server's zone or the operator's browser zone (C12).
 *
 * `formConfigId` links the task to a form the speaker fills in to complete it.
 * `null` clears the link; omitting the key leaves the stored link alone.
 */
const onboardingTaskTitleSchema = z.string().trim().min(1).max(160);
const onboardingTaskDescriptionSchema = z.string().trim().max(2000);
const onboardingTaskSortOrderSchema = z.number().int().nonnegative().max(100_000);

export const onboardingTaskCreateSchema = z
  .object({
    title: onboardingTaskTitleSchema,
    description: onboardingTaskDescriptionSchema.nullable().optional(),
    dueOn: eventDateKeySchema.nullable().optional(),
    required: z.boolean().optional(),
    formConfigId: idSchema.nullable().optional(),
    sortOrder: onboardingTaskSortOrderSchema.optional(),
  })
  .strict();

export const onboardingTaskUpdateSchema = z
  .object({
    id: idSchema,
    title: onboardingTaskTitleSchema.optional(),
    description: onboardingTaskDescriptionSchema.nullable().optional(),
    dueOn: eventDateKeySchema.nullable().optional(),
    required: z.boolean().optional(),
    formConfigId: idSchema.nullable().optional(),
    sortOrder: onboardingTaskSortOrderSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.title !== undefined ||
      value.description !== undefined ||
      value.dueOn !== undefined ||
      value.required !== undefined ||
      value.formConfigId !== undefined ||
      value.sortOrder !== undefined,
    { message: "Provide at least one task field to update." },
  );

/** Bulk fan-out takes no arguments: the event and the cohort are server-derived. */
export const onboardingTaskAssignSchema = z.object({}).strict();

export const abstractUpsertSchema = z.object({
  formConfigId: idSchema,
  abstractId: idSchema.optional(),
  title: z.string().trim().min(3).max(180),
  abstract: z.string().trim().max(5000).optional(),
  format: z.string().trim().max(80).optional(),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  categoryId: idSchema.optional(),
  // Co-speakers are keyed by email; the submission API upserts shell Users by
  // email (name filled from this payload) before creating AbstractSpeaker rows.
  speakers: coSpeakerInputSchema,
  answers: z.record(z.string(), formAnswerValueSchema),
  intent: z.enum(["saveDraft", "submit"]),
});

// Public input is deliberately narrower than signed-in speaker edits: it is
// the unauthenticated write surface and must remain well below the app-owned
// 128 KiB streamed-body limit.
const publicFormAnswerValueSchema = z.union([
  z.string().max(8_000),
  z.number().finite().min(-1_000_000).max(1_000_000),
  z.boolean(),
  z.array(z.string().max(1_000)).max(50),
  z.null(),
]);
const publicAnswersSchema = z
  .record(z.string().min(1).max(120), publicFormAnswerValueSchema)
  .superRefine((answers, ctx) => {
    if (Object.keys(answers).length > 100) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Submit no more than 100 answers." });
    }
  });
const publicSpeakerInputSchema = z
  .array(
    z.object({
      email: z.string().trim().toLowerCase().max(254).email(),
      name: z.string().trim().min(1).max(120),
      isPrimary: z.boolean().default(false),
      role: speakerRoleSchema,
    }).strict(),
  )
  .min(1)
  .max(20)
  .superRefine((speakers, ctx) => {
    const firstIndexByEmail = new Map<string, number>();
    speakers.forEach((speaker, index) => {
      const firstIndex = firstIndexByEmail.get(speaker.email);
      if (firstIndex !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "email"],
          message: `This speaker email is already used by speaker ${firstIndex + 1}.`,
        });
        return;
      }
      firstIndexByEmail.set(speaker.email, index);
    });
  });

// Parsing stays deliberately broad and body-size bounded. An absent,
// malformed, or wrong capability is normalized by the route to generic
// DRAFT_NOT_FOUND so this anonymous endpoint never becomes a capability
// oracle. The capability helper accepts only the exact 256-bit base64url form.
const draftCapabilitySchema = z.unknown().optional();
const draftRevisionSchema = z.number().int().min(0).max(2_147_483_647);

/** Strict, bounded body contract for anonymous draft and submit writes. */
export const publicAbstractUpsertSchema = z
  .object({
    formConfigId: idSchema,
    abstractId: idSchema.optional(),
    draftCapability: draftCapabilitySchema.optional(),
    expectedDraftRevision: draftRevisionSchema.optional(),
    title: z.string().trim().min(3).max(180),
    abstract: z.string().trim().max(5_000).optional(),
    format: z.string().trim().max(80).optional(),
    durationMinutes: z.number().int().min(5).max(480).optional(),
    categoryId: idSchema.optional(),
    speakers: publicSpeakerInputSchema,
    answers: publicAnswersSchema,
    intent: z.enum(["saveDraft", "submit"]),
  })
  .strict();

/** Body-only capability check for recovering an anonymous draft. */
export const publicDraftResumeSchema = z
  .object({
    formConfigId: idSchema,
    abstractId: idSchema,
    draftCapability: draftCapabilitySchema.optional(),
  })
  .strict();

export const rubricCriterionSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]*$/),
    label: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
    min: z.number().int(),
    max: z.number().int(),
    /**
     * NO `.max()` here, deliberately — see `rubricWeightBoundErrors`.
     *
     * This schema is not only a request contract: `parseDecisionRubric`
     * (lib/services/admin-decision-summary.ts) parses **already-stored** rubric
     * JSON through it, and returns null for the whole rubric on any failure,
     * which blanks that round's decision scores to "No included reviews". A
     * value-level ceiling here therefore does not reject bad input — it makes
     * existing data unreadable, and blocks an unrelated edit that merely
     * resubmits an unchanged legacy weight.
     *
     * The `RUBRIC_WEIGHT_MAX` ceiling is an **authoring** rule, so it lives in
     * the plans route, which can compare each incoming weight against the
     * freshly-read stored one and grandfather a genuinely unchanged value.
     *
     * `.finite()` and `.positive()` stay: they are true invariants rather than
     * a policy ceiling. A non-finite or non-positive weight breaks the weighted
     * average outright, and neither can survive a JSON round trip into storage
     * anyway (`JSON.stringify(Infinity)` is `null`), so keeping them rejects no
     * row that already exists.
     */
    weight: z.number().finite().positive().default(1),
  })
  .refine((criterion) => criterion.min < criterion.max, {
    message: "max must be greater than min",
    path: ["max"],
  });

export const evaluationPlanInputSchema = z.object({
  eventId: idSchema,
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(160),
  ordinal: z.number().int().positive(),
  isBlind: z.boolean().default(false),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  rubric: z.array(rubricCriterionSchema).min(1),
});

export const reviewAssignmentInputSchema = z.object({
  planId: idSchema,
  abstractIds: z.array(idSchema).min(1),
  evaluatorIds: z.array(idSchema).min(1),
  teamKey: z.string().trim().max(120).optional(),
});

/**
 * Declaring a conflict of interest (ABS-12).
 *
 * Deliberately carries no evaluator id: the assignment is resolved from the
 * caller's own session, so this body can only ever address the reviewer's own
 * row. `.strict()` keeps a status value from being smuggled in — `DECLINED` is
 * the only outcome this path can produce.
 */
export const reviewAssignmentDeclineSchema = z
  .object({
    planId: idSchema,
    abstractId: idSchema,
  })
  .strict();

/** Current-event ADMIN input for reviewer provisioning. No authority IDs are accepted. */
export const reviewerInviteCreateSchema = z
  .object({
    email: z.string().trim().toLowerCase().max(254).email(),
    name: z.string().trim().min(1).max(120),
    resend: z.boolean().default(false),
  })
  .strict();

/**
 * ADMIN input for revealing one pending reviewer's invite link. Like the
 * create contract, email is an identity lookup and never an authority id: the
 * event comes from the signed session alone.
 */
export const reviewerInviteLinkSchema = z
  .object({ email: z.string().trim().toLowerCase().max(254).email() })
  .strict();

/** Bearer input stays broad so malformed credentials remain generic 404s. */
export const reviewerInviteAcceptSchema = z
  .object({ token: z.unknown().optional() })
  .strict();

export const reviewScoreInputSchema = z.object({
  planId: idSchema,
  abstractId: idSchema,
  scores: z
    .array(
      z.object({
        rubricKey: z.string().min(1),
        score: z.number(),
        // Omission preserves an existing score comment; null clears it. The
        // route accepts at most one supplied overall comment on the plan's
        // authoritative first rubric key. Blank text is never a clear signal.
        comment: z.string().trim().min(1).max(2000).nullable().optional(),
      }),
    )
    .min(1),
  complete: z.boolean().default(false),
});

export const abstractDecisionSchema = z.object({
  abstractId: idSchema,
  decision: z.enum(["ACCEPTED", "MAYBE", "REJECTED"]),
});

export const abstractToSessionSchema = z.object({
  abstractId: idSchema,
  durationMinutes: z.number().int().min(5).max(480),
});

/**
 * Publish or unpublish one talk. Strict and deliberately two fields wide: the
 * publication route may write nothing else, and no event id is accepted — the
 * signed ADMIN context is the only event authority (INV-EVENT-001).
 */
export const sessionPublicationSchema = z
  .object({
    sessionId: idSchema,
    contentStatus: z.enum(["DRAFT", "PUBLISHED"]),
  })
  .strict();

export const guaranteedSessionInputSchema = z.object({
  eventId: idSchema,
  title: z.string().trim().min(3).max(180),
  description: z.string().trim().max(5000).optional(),
  format: z.string().trim().max(80).optional(),
  durationMinutes: z.number().int().min(5).max(480),
  speakers: coSpeakerInputSchema,
});

export const scheduleSlotInputSchema = z
  .object({
    id: idSchema.optional(),
    eventId: idSchema,
    sessionId: idSchema,
    roomId: idSchema,
    trackId: idSchema.optional(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
  })
  .refine((slot) => new Date(slot.startsAt) < new Date(slot.endsAt), {
    message: "endsAt must be after startsAt",
    path: ["endsAt"],
  });

export const scheduleConflictSchema = z.object({
  type: z.enum(["ROOM_OVERLAP", "SPEAKER_OVERLAP"]),
  slotId: idSchema.optional(),
  conflictingSlotId: idSchema,
  message: z.string(),
});

const nullableProfileText = (maxLength: number) => z.preprocess(
  (value) => typeof value === "string" ? value.trim() || null : value,
  z.string().max(maxLength).nullable(),
).optional();

const nullableProfileUrl = z.preprocess(
  (value) => typeof value === "string" ? value.trim() || null : value,
  z.string().url().nullable(),
).optional();

const nullableSocialLinks = z.record(z.string().trim().min(1), z.string().trim().url())
  .transform((links) => Object.keys(links).length === 0 ? null : links)
  .nullable()
  .optional();

export const speakerProfileUpdateSchema = z.object({
  bio: nullableProfileText(3000),
  company: nullableProfileText(160),
  jobTitle: nullableProfileText(160),
  headshotUrl: nullableProfileUrl,
  slideDeckUrl: nullableProfileUrl,
  socialLinks: nullableSocialLinks,
});

export const speakerTaskUpdateSchema = z.object({
  taskId: idSchema,
  // Waivers are an organiser decision. A speaker may work on or complete an
  // assignment, but cannot mark their own required task as waived.
  status: z.enum(["TODO", "IN_PROGRESS", "COMPLETED"]),
  artifactUrl: z.string().url().optional(),
  notes: z.string().max(1000).optional(),
});

export const resourceWikiInputSchema = z.object({
  eventId: idSchema,
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().min(1).max(180),
  summary: z.string().max(500).optional(),
  htmlContent: z.string().min(1),
  published: z.boolean(),
});

export const importRequestSchema = z.object({
  eventId: idSchema,
  format: z.enum(["csv", "json"]),
  entity: z.enum(["speakers", "abstracts", "sessions"]),
  mappings: z
    .array(z.object({ sourceField: z.string().min(1), targetField: z.string().min(1), fallback: z.string().optional() }))
    .min(1),
  payload: z.string().min(1).max(5_000_000),
});

export const acceleventsWebhookSchema = z.object({
  eventId: idSchema,
  type: z.string().min(1),
  occurredAt: z.string().datetime(),
  data: z.record(z.string(), z.unknown()),
});

export const emailDispatchRequestSchema = z.object({
  eventId: idSchema,
  templateKey: z.string().min(1),
  recipients: z.array(z.string().email()).min(1).max(500),
  variables: z.record(z.string(), z.string()).default({}),
});

export const calendarRequestSchema = z.object({ eventId: idSchema, sessionId: idSchema });

export type FormConfigInput = z.infer<typeof formConfigInputSchema>;
export type AbstractUpsert = z.infer<typeof abstractUpsertSchema>;
export type PublicAbstractUpsert = z.infer<typeof publicAbstractUpsertSchema>;
export type PublicDraftResume = z.infer<typeof publicDraftResumeSchema>;
export type EvaluationPlanInput = z.infer<typeof evaluationPlanInputSchema>;
export type ReviewScoreInput = z.infer<typeof reviewScoreInputSchema>;
export type ReviewAssignmentDeclineInput = z.infer<typeof reviewAssignmentDeclineSchema>;
export type GuaranteedSessionInput = z.infer<typeof guaranteedSessionInputSchema>;
export type ScheduleSlotInput = z.infer<typeof scheduleSlotInputSchema>;
export type ScheduleConflict = z.infer<typeof scheduleConflictSchema>;
export type SpeakerProfileUpdate = z.infer<typeof speakerProfileUpdateSchema>;
export type OnboardingTaskCreate = z.infer<typeof onboardingTaskCreateSchema>;
export type OnboardingTaskUpdate = z.infer<typeof onboardingTaskUpdateSchema>;
export type ImportRequest = z.infer<typeof importRequestSchema>;
export type EmailDispatchRequest = z.infer<typeof emailDispatchRequestSchema>;

export type ApiSuccess<T> = { ok: true; data: T };
// `retryAfterSeconds` is an additive extension: present only on refusals that
// know when they clear (rate limits), and always mirrored by `Retry-After`.
export type ApiFailure = {
  ok: false;
  error: { code: string; message: string; fieldErrors?: Record<string, string[]>; retryAfterSeconds?: number };
};
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;
