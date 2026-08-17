import { z } from "zod";
import { isIanaTimeZone } from "@/lib/tz";
import { isStoredFilePath } from "@/lib/uploads/stored-file";

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

const categoryNameSchema = z.string().trim().min(1).max(120);
const categoryDescriptionSchema = z.string().trim().max(500);
const categoryTeamKeySchema = z.string().trim().max(120);
const categorySortOrderSchema = z.number().int().nonnegative();

export const categoryInputSchema = z.object({
  eventId: idSchema,
  id: idSchema.optional(),
  name: categoryNameSchema,
  description: categoryDescriptionSchema.optional(),
  defaultTeamKey: categoryTeamKeySchema.optional(),
  sortOrder: categorySortOrderSchema.default(0),
});

/**
 * Partial category edit, the same shape as `roomUpdateSchema`.
 *
 * `categoryInputSchema` is whole-row: an update through it rewrites
 * `description`, `defaultTeamKey` and `sortOrder` from the body every time. A
 * rename sent through that contract would therefore silently clear the
 * category's `defaultTeamKey` — the value that routes its proposals to a
 * review team (`app/api/evaluations/assignments/route.ts`). This contract names
 * the row and only the fields the operator actually changed, so renaming can
 * never drop routing. `null` clears an optional column; omitting it leaves the
 * stored value alone.
 */
export const categoryUpdateSchema = z
  .object({
    id: idSchema,
    name: categoryNameSchema.optional(),
    description: categoryDescriptionSchema.nullable().optional(),
    defaultTeamKey: categoryTeamKeySchema.nullable().optional(),
    sortOrder: categorySortOrderSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined
      || value.description !== undefined
      || value.defaultTeamKey !== undefined
      || value.sortOrder !== undefined,
    { message: "Provide at least one category field to update." },
  );

const eventDateKeySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }, "Use a real calendar date.");

/** Event name and timezone are the same bounded contract whether creating or updating. */
const eventNameSchema = z.string().trim().min(1).max(160);
const eventTimezoneSchema = z.string().trim().min(1).max(100).refine(isIanaTimeZone, "Use a valid IANA timezone.");

/**
 * The paired event-date contract, shared verbatim by the settings PATCH and the
 * create POST so the two can never drift. Dates are event-local calendar keys:
 * both are supplied, both are cleared, and the pair is never inverted.
 */
export function refineEventDatePair(
  value: { startsOn?: string | null; endsOn?: string | null },
  ctx: z.RefinementCtx,
): void {
  const datesProvided = value.startsOn !== undefined || value.endsOn !== undefined;
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
}

/** Minimal, current-event-only settings update. Event deletion stays out of M5. */
export const eventSettingsUpdateSchema = z
  .object({
    name: eventNameSchema.optional(),
    timezone: eventTimezoneSchema.optional(),
    startsOn: eventDateKeySchema.nullable().optional(),
    endsOn: eventDateKeySchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const datesProvided = value.startsOn !== undefined || value.endsOn !== undefined;
    if (!value.name && !value.timezone && !datesProvided) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: "Provide at least one setting to update." });
    }
    refineEventDatePair(value, ctx);
  });

/**
 * Web address for a new event (D-C5-9). Bounded and pattern-validated on the
 * exact shape the public routes already assume: lowercase alphanumeric groups
 * joined by single dashes. The slug is immutable after creation, so this is the
 * only place it is ever accepted from a client.
 */
const eventSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "A web address is required.")
  .max(60, "Use 60 characters or fewer.")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single dashes.");

/**
 * Create one empty event (D-C5-9). Name, slug, dates and timezone only — no
 * cloning, no cross-event copying, no deletion. Dates stay optional so an event
 * can be opened before its dates are decided, but the pair rule is identical to
 * the settings PATCH.
 */
export const eventCreateSchema = z
  .object({
    name: eventNameSchema,
    slug: eventSlugSchema,
    timezone: eventTimezoneSchema,
    startsOn: eventDateKeySchema.nullable().optional(),
    endsOn: eventDateKeySchema.nullable().optional(),
  })
  .strict()
  .superRefine(refineEventDatePair);

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
 * Programme tracks — the schedule's swimlanes, authored alongside rooms.
 *
 * `Track.color` is a required, operator-chosen column that the agenda chip and
 * the public schedule render as a background, so it is bounded here to exactly
 * the hex forms `parseHex` in `lib/color-contrast.ts` can read. An unparseable
 * value would not fail loudly; it would silently render every affected slot in
 * the grey `FALLBACK_BACKGROUND`, so the boundary is the right place to refuse
 * it. The other two fields mirror `roomNameSchema`/`roomSortOrderSchema`
 * because a track and a room are authored on the same settings surface.
 */
const trackNameSchema = z.string().trim().min(1).max(120);
const trackColorSchema = z
  .string()
  .trim()
  .regex(/^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Use a hex colour such as #6366f1.");
const trackSortOrderSchema = z.number().int().nonnegative().max(100_000);

export const trackCreateSchema = z
  .object({
    name: trackNameSchema,
    color: trackColorSchema,
    sortOrder: trackSortOrderSchema.optional(),
  })
  .strict();

export const trackUpdateSchema = z
  .object({
    id: idSchema,
    name: trackNameSchema.optional(),
    color: trackColorSchema.optional(),
    sortOrder: trackSortOrderSchema.optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.color !== undefined || value.sortOrder !== undefined, {
    message: "Provide at least one track field to update.",
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

/**
 * R4 — a repeated id in either array is a duplicate request, not a bad one.
 *
 * The assignment route establishes scope by comparing what the database
 * returned against `input.<ids>.length` at three separate points (the
 * authorization preflight, the post-lock re-read, and the evaluator-role
 * check). Every one of those reads is a set, so `["a", "a"]` came back as one
 * row and the route answered `422 INVALID_ABSTRACTS` / `INVALID_EVALUATORS` —
 * telling an admin their proposal was "not in this event" when it was, purely
 * because a UI multi-select or a retried payload named it twice. The upsert
 * loop below is idempotent on (plan, abstract, evaluator), so the duplicate
 * would also have inflated the returned `assignments` count for work done once.
 *
 * Deduped here rather than at the three comparison sites so the invariant is
 * stated once and every consumer of the parsed input sees the same set. Order
 * is preserved: it is the order the assignments are written in.
 */
const uniqueIds = (ids: string[]) => [...new Set(ids)];

export const reviewAssignmentInputSchema = z.object({
  planId: idSchema,
  abstractIds: z.array(idSchema).min(1).transform(uniqueIds),
  evaluatorIds: z.array(idSchema).min(1).transform(uniqueIds),
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

/**
 * Self-service auth input (D-C5-16 item 2).
 *
 * Shape only. The password **strength** floor lives in
 * `lib/services/password-policy.ts` so one rule serves signup and reset and the
 * message is written once; these schemas bound length and reject anything that
 * is not a plausible address before a scrypt is ever paid for.
 *
 * `.strict()` on every one: an authority identifier — an event, a role, a user
 * id — must never be accepted from an unauthenticated body, and the strict
 * object is what makes that a refusal rather than a silently ignored field.
 */
const selfServiceEmailSchema = z.string().trim().toLowerCase().max(254).email();
/** Bounded here; `checkNewPassword` owns whether it is good enough. */
const selfServiceSecretSchema = z.string().max(512);

export const signupSchema = z
  .object({
    email: selfServiceEmailSchema,
    password: selfServiceSecretSchema,
    confirmPassword: selfServiceSecretSchema,
  })
  .strict();

export const forgotPasswordSchema = z
  .object({ email: selfServiceEmailSchema })
  .strict();

export const passwordResetSchema = z
  .object({
    token: z.string().min(1).max(512),
    password: selfServiceSecretSchema,
    confirmPassword: selfServiceSecretSchema,
  })
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

/**
 * How many proposals one bulk decision may name.
 *
 * The batch is a loop of independent transactions, so this bound is about the
 * request's own duration rather than a lock: a hundred sequential provisioning
 * transactions is already the far end of what an operator should wait on one
 * response for, and the table the selection is made in loads at most a hundred
 * rows anyway (`QUERY_LIMITS.adminAbstracts`). Beyond it the request is refused
 * whole, before any write — a partially applied batch nobody asked for would be
 * worse than a refusal the operator can split.
 */
export const BULK_ABSTRACT_DECISION_LIMIT = 100;

/**
 * Deciding a selection. Ids are deduplicated exactly as the review-assignment
 * body dedupes them: a multi-select or a retried payload naming the same
 * proposal twice must not produce two entries in the per-item report for one
 * write. `.max()` runs on the array as sent, so padding a request with
 * duplicates cannot buy a larger batch.
 */
export const bulkAbstractDecisionSchema = z.object({
  abstractIds: z.array(idSchema).min(1).max(BULK_ABSTRACT_DECISION_LIMIT).transform(uniqueIds),
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

/** The fields `sessionUpdateSchema` may name, beside the session id itself. */
export const SESSION_UPDATE_FIELDS = [
  "contentStatus",
  "title",
  "description",
  "format",
  "durationMinutes",
  "categoryId",
] as const;

/**
 * Edit one confirmed talk (admin) — its publication status, and now its content.
 *
 * A programme committee accepts a proposal and then has to fix its title's
 * typo, tighten the blurb the public page shows, re-label its format, or move
 * it to the topic it actually belongs to. Until now nothing could: the speaker
 * owned the source `Abstract` (INV-EDIT-001) and the admin owned only
 * `contentStatus`, so a confirmed talk's own text had no editor at all.
 *
 * A **superset** of `sessionPublicationSchema`, built from it by `.extend()` so
 * the two cannot drift: every body the publication toggle ever sent is still
 * accepted, unchanged, and still writes exactly `contentStatus`. Every field is
 * optional and a patch is sparse — an absent key means "leave it alone", which
 * is what lets one route serve both the one-field toggle and the content form
 * without a second endpoint or a discriminator the old client never sent.
 *
 * `description` and `format` are nullable because clearing them is a real edit
 * and `null` is the only way to say it; `""` is normalized to `null` by
 * `sessionUpdateData` rather than stored as a blank string. `categoryId` is
 * nullable for the same reason (`Session.categoryId` is optional) and is
 * authorized against this event inside the write transaction — the schema can
 * only say it is an id, never whose.
 *
 * Still no `eventId`: the signed ADMIN context is the only event authority
 * (INV-EVENT-001). The speaker roster is deliberately absent too — naming who
 * presents a confirmed talk is `POST /api/admin/speakers`' job under its own
 * identity locks, and INV-EDIT-001 locks the roster once a `Session` exists.
 */
export const sessionUpdateSchema = sessionPublicationSchema
  .extend({
    contentStatus: z.enum(["DRAFT", "PUBLISHED"]).optional(),
    title: z.string().trim().min(3).max(180).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    format: z.string().trim().max(80).nullable().optional(),
    durationMinutes: z.number().int().min(5).max(480).optional(),
    categoryId: idSchema.nullable().optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    // A body that names only a session id is not an edit. Refused at the
    // boundary, where it is a named validation failure, rather than reaching
    // the database as an empty `data: {}` update that would bump `updatedAt`
    // and report success for a write nobody asked for.
    if (SESSION_UPDATE_FIELDS.every((field) => input[field] === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "Name at least one field to change.",
      });
    }
  });

/**
 * How many people may be named on one directly authored talk. The same bound
 * `coSpeakerInputSchema` puts on a proposal's roster, for the same reason: a
 * talk's speaker list is a stage line-up, not a mailing list.
 */
export const GUARANTEED_SESSION_MAX_SPEAKERS = 20;

/**
 * A talk authored directly on the programme — a keynote, a sponsor slot — with
 * no source proposal (`Session.sourceAbstractId` is nullable, INV-DOMAIN-001).
 *
 * **Speakers are roster user ids, not email/name pairs.** This schema formerly
 * reused `coSpeakerInputSchema`, which is the *proposal* contract: it names
 * people by email so an anonymous CFP submission can mint the accounts behind
 * them. Creating a global `User` is `POST /api/admin/speakers`' job and takes
 * that route's C17 identity lock order to do it safely; a programme surface
 * that silently minted accounts as a side effect of scheduling a keynote would
 * be doing identity work under the wrong lock. Naming someone already on this
 * event's roster is instead a pure `SessionSpeaker` write, and an id that is
 * not on the roster is refused rather than invented.
 *
 * Speakers are also **optional** here, where a proposal's roster is `.min(1)`:
 * a sponsor slot is routinely blocked out before anyone knows who will present
 * it, and a proposal without a submitter is not a thing that exists.
 *
 * `eventId` is carried in the body and checked against the signed ADMIN context
 * with `assertEventScope`, matching the neighbouring agenda writers
 * (`scheduleSlotInputSchema`, the autoplace pair) rather than
 * `sessionPublicationSchema`, which addresses a session id alone.
 */
export const guaranteedSessionInputSchema = z
  .object({
    eventId: idSchema,
    title: z.string().trim().min(3).max(180),
    description: z.string().trim().max(5000).optional(),
    format: z.string().trim().max(80).optional(),
    durationMinutes: z.number().int().min(5).max(480),
    speakers: z
      .array(
        z.object({
          userId: idSchema,
          isPrimary: z.boolean().default(false),
        }),
      )
      .max(GUARANTEED_SESSION_MAX_SPEAKERS)
      .default([]),
  })
  .strict()
  .superRefine((input, ctx) => {
    // `SessionSpeaker` is keyed on (sessionId, userId), so a repeated id would
    // reach the database as a unique violation and surface as a 500. Refused at
    // the boundary instead, where it is a named validation failure.
    const seen = new Set<string>();
    for (const [index, speaker] of input.speakers.entries()) {
      if (seen.has(speaker.userId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["speakers", index, "userId"],
          message: "Name each speaker only once.",
        });
      }
      seen.add(speaker.userId);
    }
    // One stage lead. The proposal path derives its primary from the submitter,
    // so this is the only surface where a caller could assert two.
    if (input.speakers.filter((speaker) => speaker.isPrimary).length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["speakers"],
        message: "Only one speaker can be the primary speaker.",
      });
    }
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
  /**
   * Additive: which speaker is double-booked, for `SPEAKER_OVERLAP` only.
   * Detection always knew this — it is the id it matched on — and dropping it
   * was what forced the refusal to say "a speaker" instead of naming them.
   * Absent on `ROOM_OVERLAP`, so it stays optional.
   */
  speakerId: idSchema.optional(),
});

const nullableProfileText = (maxLength: number) => z.preprocess(
  (value) => typeof value === "string" ? value.trim() || null : value,
  z.string().max(maxLength).nullable(),
).optional();

/**
 * A profile link: an absolute URL exactly as before, **or** one of this app's
 * own upload URLs.
 *
 * The `.url()` branch is untouched, so GRA2-07's documented follow-up (that
 * `.url()` still accepts non-HTTP schemes, re-filtered by the public image
 * renderer) neither improves nor worsens here. The second branch is not a
 * widening of what counts as a URL: `isStoredFilePath` accepts `/api/files/<id>`
 * and literally nothing else — no scheme, no host, no traversal, no query — so
 * an uploaded file can be stored in the same column as a pasted link without
 * that column becoming able to hold a relative path in general.
 */
const nullableProfileUrl = z.preprocess(
  (value) => typeof value === "string" ? value.trim() || null : value,
  z.union([
    z.string().url(),
    z.string().refine(isStoredFilePath, { message: "Invalid url" }),
  ]).nullable(),
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

/**
 * The portal's own PATCH body: the global profile fields above, plus one deck
 * for the caller's CURRENT event.
 *
 * A separate schema rather than a sixth key on `speakerProfileUpdateSchema`,
 * because that schema's keys are `SpeakerProfile` COLUMNS — the organizer
 * roster editor `.pick()`s from it, `lib/services/speaker-roster` maps it
 * straight onto a Prisma write, and the v1 API's published `SpeakerProfile`
 * object describes exactly those. `eventSlideDeckUrl` is not a column on that
 * row and never becomes one: it addresses an `EventSpeakerDeck` association.
 *
 * Same validator as the global column it falls back to (`nullableProfileUrl`),
 * so the two hold the same kind of value: an absolute URL, or this app's own
 * `/api/files/<id>` path. Same semantics too — an omitted key preserves, and an
 * explicit `null` clears, which deletes the association and lets the global
 * deck become the fallback again.
 */
export const portalProfileUpdateSchema = speakerProfileUpdateSchema.extend({
  eventSlideDeckUrl: nullableProfileUrl,
});

export const speakerTaskUpdateSchema = z.object({
  taskId: idSchema,
  // Waivers are an organiser decision. A speaker may work on or complete an
  // assignment, but cannot mark their own required task as waived.
  status: z.enum(["TODO", "IN_PROGRESS", "COMPLETED"]),
  artifactUrl: z.string().url().optional(),
  notes: z.string().max(1000).optional(),
});

/**
 * Address of one resource page inside the portal (`/portal/resources/<slug>`).
 * The same shape and bound as `eventSlugSchema` — this one stays editable, but
 * it is the same kind of value: a unique, lowercase URL path segment. It was
 * previously unbounded and untrimmed, which an authored `@@unique([eventId,
 * slug])` column should never be.
 */
const resourceSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "A web address is required.")
  .max(60, "Use 60 characters or fewer.")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single dashes.");

const resourceTitleSchema = z.string().trim().min(1).max(180);
const resourceSummarySchema = z.string().trim().max(500);
/**
 * The authored body. Bounded here, and sanitized server-side at write time by
 * `prepareResourceHtml` (INV-HTML-001) before it is ever stored — in addition
 * to the portal reader's own sanitize-on-render, which stays.
 */
const resourceHtmlSchema = z.string().min(1).max(200_000);

export const resourceWikiInputSchema = z.object({
  eventId: idSchema,
  slug: resourceSlugSchema,
  title: resourceTitleSchema,
  summary: resourceSummarySchema.optional(),
  htmlContent: resourceHtmlSchema,
  published: z.boolean(),
});

/**
 * Edit one stored resource. No `eventId`: scope comes from the stored row read
 * under its own write lock (the S1 event-owned pattern), never from the body.
 * `summary` is nullable so an organizer can actually clear it, and every field
 * is optional so the publish toggle is a one-field PATCH.
 */
export const resourceWikiUpdateSchema = z
  .object({
    id: idSchema,
    slug: resourceSlugSchema.optional(),
    title: resourceTitleSchema.optional(),
    summary: resourceSummarySchema.nullable().optional(),
    htmlContent: resourceHtmlSchema.optional(),
    published: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.slug !== undefined ||
      value.title !== undefined ||
      value.summary !== undefined ||
      value.htmlContent !== undefined ||
      value.published !== undefined,
    { message: "Provide at least one resource field to update." },
  );

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
export type SessionUpdateInput = z.infer<typeof sessionUpdateSchema>;
export type ScheduleSlotInput = z.infer<typeof scheduleSlotInputSchema>;
export type ScheduleConflict = z.infer<typeof scheduleConflictSchema>;
export type SpeakerProfileUpdate = z.infer<typeof speakerProfileUpdateSchema>;
export type OnboardingTaskCreate = z.infer<typeof onboardingTaskCreateSchema>;
export type OnboardingTaskUpdate = z.infer<typeof onboardingTaskUpdateSchema>;
export type ResourceWikiInput = z.infer<typeof resourceWikiInputSchema>;
export type ResourceWikiUpdate = z.infer<typeof resourceWikiUpdateSchema>;
export type ImportRequest = z.infer<typeof importRequestSchema>;
export type EmailDispatchRequest = z.infer<typeof emailDispatchRequestSchema>;
export type SignupInput = z.infer<typeof signupSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type PasswordResetInput = z.infer<typeof passwordResetSchema>;

export type ApiSuccess<T> = { ok: true; data: T };
// `retryAfterSeconds` is an additive extension: present only on refusals that
// know when they clear (rate limits), and always mirrored by `Retry-After`.
export type ApiFailure = {
  ok: false;
  error: { code: string; message: string; fieldErrors?: Record<string, string[]>; retryAfterSeconds?: number };
};
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;
