/**
 * Server-side reads for the frontend screens.
 *
 * These run in server components and query Prisma directly rather than fetching
 * this app's own HTTP API: an internal fetch would need manual cookie
 * forwarding and costs an extra round trip per page (the sprint judges on
 * performance). Authorization still goes through the backend-owned
 * `requireContext()` helper, so INV-EVENT-001 event scoping is identical to the
 * API routes, and the returned shapes mirror the corresponding endpoints:
 *
 *   getAdminAbstracts()   ~ GET /api/cfp/submissions
 *   getAgendaData()       ~ GET /api/agenda
 *   getFormsList()        ~ GET /api/cfp/forms
 *   getFormForBuilder()   ~ GET /api/cfp/forms/:id
 *   getEvaluationQueue()  ~ GET /api/evaluations/{plans,assignments}
 *   getPublicForm()       ~ GET /api/cfp/public/:formId
 *   getPublicAgenda()     ~ GET /api/agenda/public
 *   getPublicSpeakers()   ~ public scheduled-speaker projection
 *   getEmbedTargets()     ~ admin metadata for the embed snippet page
 *
 * Mutations always go through the HTTP API from client components (see
 * `lib/api-client.ts`) so validation and invariants stay server-enforced.
 */
import type { AbstractStatus, FormFieldType, Prisma, UserRole } from "@prisma/client";
import { cache } from "react";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getApiContext, type ApiContext } from "@/lib/api/context";
import { serializeForm, serializePublicForm } from "@/lib/api/form-serialize";
import {
  buildPublicSpeakers,
  PUBLIC_SPEAKER_LIMITS,
  type PublicSpeakers,
} from "@/lib/public-speakers";

/**
 * Page-level auth: redirect to `/login` rather than throwing.
 *
 * `requireContext()` throws `ApiError(401)`, which is right for an API route but
 * renders an error page here — a layout's `requireSession()` redirect cannot win
 * because Next renders layouts and pages in parallel. This resolves the same
 * context (user by email + event membership, INV-EVENT-001) and redirects on
 * missing session or insufficient role.
 */
async function pageContext(roles?: UserRole[]): Promise<ApiContext> {
  const ctx = await getApiContext();
  if (!ctx) redirect("/login");
  if (roles && !roles.includes(ctx.role)) redirect("/login");
  return ctx;
}

export type FieldOption = { label: string; value: string };
export type ConditionalLogicJson = {
  match: "all" | "any";
  rules: { fieldKey: string; operator: string; value?: string | number | boolean }[];
};

export type FieldView = {
  id: string;
  key: string;
  label: string;
  helpText: string | null;
  type: FormFieldType;
  required: boolean;
  options: FieldOption[] | null;
  conditionalLogic: ConditionalLogicJson | null;
  sortOrder: number;
};

/** Narrow the loosely-typed JSON columns coming back from Prisma. */
function normalizeField(field: {
  id: string;
  key: string;
  label: string;
  helpText: string | null;
  type: FormFieldType;
  required: boolean;
  options: unknown;
  conditionalLogic: unknown;
  sortOrder: number;
}): FieldView {
  return {
    ...field,
    options: Array.isArray(field.options) ? (field.options as FieldOption[]) : null,
    conditionalLogic:
      field.conditionalLogic && typeof field.conditionalLogic === "object"
        ? (field.conditionalLogic as ConditionalLogicJson)
        : null,
  };
}

// ---- Forms ----------------------------------------------------------------

export type FormListItem = {
  id: string;
  name: string;
  slug: string;
  published: boolean;
  submissionCount: number;
  draftCount: number;
  closesAt: string | null;
  opensAt: string | null;
  isOpen: boolean;
};

export async function getFormsList(): Promise<{ eventId: string; forms: FormListItem[] }> {
  const ctx = await pageContext(["ADMIN"]);
  const [forms, grouped] = await Promise.all([
    prisma.formConfig.findMany({
      where: { eventId: ctx.eventId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        slug: true,
        published: true,
        opensAt: true,
        closesAt: true,
      },
    }),
    // One grouped query instead of a count per form (avoids N+1).
    prisma.abstract.groupBy({
      by: ["formConfigId", "status"],
      where: { eventId: ctx.eventId },
      _count: { _all: true },
    }),
  ]);

  const now = Date.now();
  return {
    eventId: ctx.eventId,
    forms: forms.map((form) => {
      const rows = grouped.filter((g) => g.formConfigId === form.id);
      const draftCount = rows
        .filter((r) => r.status === "DRAFT")
        .reduce((n, r) => n + r._count._all, 0);
      const submissionCount = rows
        .filter((r) => r.status !== "DRAFT")
        .reduce((n, r) => n + r._count._all, 0);
      return {
        id: form.id,
        name: form.name,
        slug: form.slug,
        published: form.published,
        opensAt: form.opensAt?.toISOString() ?? null,
        closesAt: form.closesAt?.toISOString() ?? null,
        submissionCount,
        draftCount,
        isOpen:
          form.published &&
          (!form.opensAt || now >= form.opensAt.getTime()) &&
          (!form.closesAt || now < form.closesAt.getTime()),
      };
    }),
  };
}

// `Omit` the serializer's loosely-typed `fields` so the narrowed `FieldView[]`
// replaces it instead of intersecting with the raw Prisma JSON types.
export type BuilderForm = Omit<ReturnType<typeof serializeForm>, "fields"> & {
  fields: FieldView[];
};

export async function getFormForBuilder(
  formId: string,
): Promise<{ eventId: string; timezone: string; form: BuilderForm } | null> {
  const ctx = await pageContext(["ADMIN"]);
  const [form, event] = await Promise.all([
    prisma.formConfig.findFirst({
      where: { id: formId, eventId: ctx.eventId },
      include: { fields: true },
    }),
    prisma.event.findUnique({ where: { id: ctx.eventId }, select: { timezone: true } }),
  ]);
  if (!form) return null;
  const serialized = serializeForm(form);
  return {
    eventId: ctx.eventId,
    timezone: event?.timezone ?? "UTC",
    form: { ...serialized, fields: form.fields.slice().sort((a, b) => a.sortOrder - b.sortOrder).map(normalizeField) },
  };
}

// ---- Abstracts pipeline ---------------------------------------------------

export type AnswerRow = {
  fieldId: string;
  label: string;
  type: FormFieldType;
  options: FieldOption[] | null;
  value: unknown;
};

/**
 * One page read will materialize at most this many stored answers across the
 * whole event. ~40 abstracts x 125 fields; real CFP forms carry well under 30
 * questions, so this is a guard against a pathological event, not a normal cap.
 */
const ADMIN_ANSWER_LIMIT = 5_000;

export type AbstractRow = {
  id: string;
  title: string;
  abstract: string | null;
  status: AbstractStatus;
  format: string | null;
  durationMinutes: number | null;
  categoryName: string | null;
  formName: string;
  speakers: { name: string; email: string; isPrimary: boolean }[];
  submittedAt: string | null;
  reviewsComplete: number;
  reviewsTotal: number;
  avgScore: number | null;
  /** Custom CFP answers, in form order. Empty when the form had no extra questions. */
  answers: AnswerRow[];
  /**
   * True when this event has more stored answers than one page read will
   * materialize, so this row's answers were not loaded. Surfaced in the UI
   * rather than silently showing an empty section.
   */
  answersUnavailable: boolean;
  hasSession: boolean;
  /** The confirmed talk created from this proposal, if conversion has happened. */
  sessionId: string | null;
  /** True when that talk also holds a schedule slot, i.e. it is on the public programme. */
  sessionScheduled: boolean;
};

type AssignmentProgressGroup = {
  abstractId: string;
  status: string;
  _count: { _all: number };
};

export function indexAssignmentProgress(groups: readonly AssignmentProgressGroup[]) {
  const progressByAbstract = new Map<string, { reviewsTotal: number; reviewsComplete: number }>();
  for (const group of groups) {
    const progress = progressByAbstract.get(group.abstractId) ?? { reviewsTotal: 0, reviewsComplete: 0 };
    progress.reviewsTotal += group._count._all;
    if (group.status === "COMPLETED") progress.reviewsComplete += group._count._all;
    progressByAbstract.set(group.abstractId, progress);
  }
  return progressByAbstract;
}

export async function getAdminAbstracts(): Promise<{ eventId: string; abstracts: AbstractRow[] }> {
  const ctx = await pageContext(["ADMIN", "EVALUATOR"]);

  const [abstracts, assignmentGroups, scoreRows, answerRows] = await Promise.all([
    prisma.abstract.findMany({
      where: { eventId: ctx.eventId },
      orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        title: true,
        abstract: true,
        status: true,
        format: true,
        durationMinutes: true,
        submittedAt: true,
        category: { select: { name: true } },
        formConfig: { select: { name: true } },
        speakers: {
          select: { isPrimary: true, user: { select: { name: true, email: true } } },
        },
        // `scheduleSlot` tells the admin table whether the confirmed talk is
        // actually on the public programme, which is what makes a reversed
        // decision consequential (INV-DOMAIN-001: we never auto-delete it).
        session: { select: { id: true, scheduleSlot: { select: { id: true } } } },
      },
    }),
    // Review progress without a per-row query.
    prisma.reviewAssignment.groupBy({
      by: ["abstractId", "status"],
      where: { abstract: { eventId: ctx.eventId } },
      _count: { _all: true },
    }),
    prisma.reviewScore.groupBy({
      by: ["abstractId"],
      where: { abstract: { eventId: ctx.eventId } },
      _avg: { score: true },
    }),
    // The drawer shows what the speaker actually answered. One bounded query for
    // the whole event beats a per-abstract read when the drawer opens, and the
    // deterministic ordering makes the truncation cut reproducible.
    prisma.formAnswer.findMany({
      where: { abstract: { eventId: ctx.eventId } },
      orderBy: [{ abstractId: "asc" }, { formField: { sortOrder: "asc" } }, { formFieldId: "asc" }],
      take: ADMIN_ANSWER_LIMIT + 1,
      select: {
        abstractId: true,
        value: true,
        formField: { select: { id: true, label: true, type: true, options: true } },
      },
    }),
  ]);

  const assignmentProgressByAbstract = indexAssignmentProgress(assignmentGroups);
  const avgByAbstract = new Map(scoreRows.map((r) => [r.abstractId, r._avg.score]));

  // Over the bound: drop the overflow row and report honestly instead of
  // rendering a silently-partial answer list.
  const answersTruncated = answerRows.length > ADMIN_ANSWER_LIMIT;
  const answersByAbstract = new Map<string, AnswerRow[]>();
  for (const row of answerRows.slice(0, ADMIN_ANSWER_LIMIT)) {
    const list = answersByAbstract.get(row.abstractId) ?? [];
    list.push({
      fieldId: row.formField.id,
      label: row.formField.label,
      type: row.formField.type,
      options: Array.isArray(row.formField.options)
        ? (row.formField.options as FieldOption[])
        : null,
      value: row.value,
    });
    answersByAbstract.set(row.abstractId, list);
  }

  return {
    eventId: ctx.eventId,
    abstracts: abstracts.map((a) => {
      const reviewProgress = assignmentProgressByAbstract.get(a.id) ?? { reviewsTotal: 0, reviewsComplete: 0 };
      const avg = avgByAbstract.get(a.id);
      return {
        id: a.id,
        title: a.title,
        abstract: a.abstract,
        status: a.status,
        format: a.format,
        durationMinutes: a.durationMinutes,
        categoryName: a.category?.name ?? null,
        formName: a.formConfig.name,
        speakers: a.speakers.map((s) => ({
          name: s.user.name,
          email: s.user.email,
          isPrimary: s.isPrimary,
        })),
        submittedAt: a.submittedAt?.toISOString() ?? null,
        reviewsComplete: reviewProgress.reviewsComplete,
        reviewsTotal: reviewProgress.reviewsTotal,
        avgScore: avg === null || avg === undefined ? null : Number(avg),
        answers: answersByAbstract.get(a.id) ?? [],
        answersUnavailable: answersTruncated && !answersByAbstract.has(a.id),
        hasSession: a.session !== null,
        sessionId: a.session?.id ?? null,
        sessionScheduled: a.session?.scheduleSlot != null,
      };
    }),
  };
}

// ---- Agenda ---------------------------------------------------------------

export type AgendaSession = {
  id: string;
  title: string;
  format: string | null;
  durationMinutes: number;
  speakers: { userId: string; name: string }[];
  slot: {
    id: string;
    roomId: string;
    trackId: string | null;
    startsAt: string;
    endsAt: string;
  } | null;
};

export type AgendaData = {
  eventId: string;
  timezone: string;
  rooms: { id: string; name: string; capacity: number | null }[];
  tracks: { id: string; name: string; color: string }[];
  sessions: AgendaSession[];
};

export async function getAgendaData(): Promise<AgendaData> {
  const ctx = await pageContext(["ADMIN"]);
  const [event, rooms, tracks, sessions] = await Promise.all([
    prisma.event.findUnique({ where: { id: ctx.eventId }, select: { timezone: true } }),
    prisma.room.findMany({
      where: { eventId: ctx.eventId },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true, capacity: true },
    }),
    prisma.track.findMany({
      where: { eventId: ctx.eventId },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true, color: true },
    }),
    prisma.session.findMany({
      where: { eventId: ctx.eventId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        title: true,
        format: true,
        durationMinutes: true,
        speakers: { select: { userId: true, user: { select: { name: true } } } },
        scheduleSlot: {
          select: { id: true, roomId: true, trackId: true, startsAt: true, endsAt: true },
        },
      },
    }),
  ]);

  return {
    eventId: ctx.eventId,
    timezone: event?.timezone ?? "UTC",
    rooms,
    tracks,
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      format: s.format,
      durationMinutes: s.durationMinutes,
      speakers: s.speakers.map((sp) => ({ userId: sp.userId, name: sp.user.name })),
      slot: s.scheduleSlot
        ? {
            id: s.scheduleSlot.id,
            roomId: s.scheduleSlot.roomId,
            trackId: s.scheduleSlot.trackId,
            startsAt: s.scheduleSlot.startsAt.toISOString(),
            endsAt: s.scheduleSlot.endsAt.toISOString(),
          }
        : null,
    })),
  };
}

// ---- Evaluation ----------------------------------------------------------

export type RubricCriterionView = {
  key: string;
  label: string;
  description?: string;
  min: number;
  max: number;
  weight: number;
};

export type QueueRow = {
  abstractId: string;
  title: string;
  abstractBody: string | null;
  categoryName: string | null;
  teamKey: string | null;
  status: "ASSIGNED" | "IN_PROGRESS" | "COMPLETED" | "DECLINED";
  speakers: string[];
  myScores: Record<string, number>;
  myComment: string | null;
};

export type EvaluationView = {
  eventId: string;
  role: string;
  plan: {
    id: string;
    name: string;
    ordinal: number;
    isBlind: boolean;
    rubric: RubricCriterionView[];
    assignmentCount: number;
    completedCount: number;
  } | null;
  queue: QueueRow[];
};

/**
 * The scoring queue for the signed-in reviewer.
 *
 * Always filtered to the caller's own assignments: `POST /api/evaluations/scores`
 * rejects an unassigned reviewer with `NOT_ASSIGNED`, so showing another
 * reviewer's rows would render an unusable form.
 */
export async function getEvaluationQueue(): Promise<EvaluationView> {
  const ctx = await pageContext(["ADMIN", "EVALUATOR"]);

  const plan = await prisma.evaluationPlan.findFirst({
    where: { eventId: ctx.eventId },
    orderBy: { ordinal: "desc" },
    include: { _count: { select: { assignments: true } } },
  });
  if (!plan) {
    return { eventId: ctx.eventId, role: ctx.role, plan: null, queue: [] };
  }

  const [assignments, myScores, completedCount] = await Promise.all([
    prisma.reviewAssignment.findMany({
      where: { planId: plan.id, evaluatorId: ctx.userId },
      orderBy: { assignedAt: "asc" },
      select: {
        abstractId: true,
        teamKey: true,
        status: true,
        abstract: {
          select: {
            title: true,
            abstract: true,
            category: { select: { name: true } },
            speakers: { select: { user: { select: { name: true } } } },
          },
        },
      },
    }),
    prisma.reviewScore.findMany({
      where: { planId: plan.id, evaluatorId: ctx.userId },
      select: { abstractId: true, rubricKey: true, score: true, comment: true },
    }),
    prisma.reviewAssignment.count({ where: { planId: plan.id, status: "COMPLETED" } }),
  ]);

  const scoresByAbstract = new Map<string, { scores: Record<string, number>; comment: string | null }>();
  for (const row of myScores) {
    const entry = scoresByAbstract.get(row.abstractId) ?? { scores: {}, comment: null };
    entry.scores[row.rubricKey] = Number(row.score);
    if (row.comment) entry.comment = row.comment;
    scoresByAbstract.set(row.abstractId, entry);
  }

  const rubric = Array.isArray(plan.rubric) ? (plan.rubric as unknown as RubricCriterionView[]) : [];
  const blind = plan.isBlind && ctx.role === "EVALUATOR";

  return {
    eventId: ctx.eventId,
    role: ctx.role,
    plan: {
      id: plan.id,
      name: plan.name,
      ordinal: plan.ordinal,
      isBlind: plan.isBlind,
      rubric,
      assignmentCount: plan._count.assignments,
      completedCount,
    },
    queue: assignments.map((a) => {
      const mine = scoresByAbstract.get(a.abstractId);
      return {
        abstractId: a.abstractId,
        title: a.abstract.title,
        abstractBody: a.abstract.abstract,
        categoryName: a.abstract.category?.name ?? null,
        teamKey: a.teamKey,
        status: a.status,
        speakers: blind ? [] : a.abstract.speakers.map((s) => s.user.name),
        myScores: mine?.scores ?? {},
        myComment: mine?.comment ?? null,
      };
    }),
  };
}

// ---- Public surfaces -----------------------------------------------------

export type PublicFormView = Omit<ReturnType<typeof serializePublicForm>, "fields"> & {
  fields: FieldView[];
  categories: { id: string; name: string }[];
  eventName: string;
};

/**
 * Public CFP form by id or slug. No session required.
 *
 * Categories are read here rather than from `GET /api/cfp/categories` because
 * that endpoint requires ADMIN/EVALUATOR; the submitter needs to pick one for
 * category-based review routing to work.
 */
export const getPublicForm = cache(async function getPublicForm(formId: string): Promise<PublicFormView | null> {
  const form = await prisma.formConfig.findFirst({
    where: { published: true, OR: [{ id: formId }, { slug: formId }] },
    include: { fields: true, event: { select: { name: true } } },
  });
  if (!form) return null;

  const categories = await prisma.category.findMany({
    where: { eventId: form.eventId },
    orderBy: { sortOrder: "asc" },
    select: { id: true, name: true },
  });

  const serialized = serializePublicForm(form);
  return {
    ...serialized,
    fields: form.fields.slice().sort((a, b) => a.sortOrder - b.sortOrder).map(normalizeField),
    categories,
    eventName: form.event.name,
  };
});

export type PublicAgendaSession = {
  slotId: string;
  sessionId: string;
  title: string;
  description: string | null;
  room: { id: string; name: string };
  track: { id: string; name: string; color: string } | null;
  startsAt: string;
  endsAt: string;
  speakers: string[];
};

export type PublicAgenda = {
  event: { id: string; name: string; slug: string; timezone: string; startsAt: string | null; endsAt: string | null };
  tracks: { id: string; name: string; color: string }[];
  sessions: PublicAgendaSession[];
};

export const getPublicAgenda = cache(async function getPublicAgenda(eventParam = "forward-2026"): Promise<PublicAgenda | null> {
  const event = await prisma.event.findFirst({
    where: { OR: [{ id: eventParam }, { slug: eventParam }] },
    select: { id: true, name: true, slug: true, timezone: true, startsAt: true, endsAt: true },
  });
  if (!event) return null;

  const [tracks, slots] = await Promise.all([
    prisma.track.findMany({
      where: { eventId: event.id },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true, color: true },
    }),
    prisma.scheduleSlot.findMany({
      where: { eventId: event.id },
      orderBy: { startsAt: "asc" },
      select: {
        id: true,
        sessionId: true,
        startsAt: true,
        endsAt: true,
        room: { select: { id: true, name: true } },
        track: { select: { id: true, name: true, color: true } },
        session: {
          select: {
            title: true,
            description: true,
            speakers: { select: { user: { select: { name: true } } } },
          },
        },
      },
    }),
  ]);

  return {
    event: {
      ...event,
      startsAt: event.startsAt?.toISOString() ?? null,
      endsAt: event.endsAt?.toISOString() ?? null,
    },
    tracks,
    sessions: slots.map((slot) => ({
      slotId: slot.id,
      sessionId: slot.sessionId,
      title: slot.session.title,
      description: slot.session.description,
      room: slot.room,
      track: slot.track,
      startsAt: slot.startsAt.toISOString(),
      endsAt: slot.endsAt.toISOString(),
      speakers: slot.session.speakers.map((s) => s.user.name),
    })),
  };
});

export const getPublicSpeakers = cache(async function getPublicSpeakers(
  eventParam = "forward-2026",
): Promise<PublicSpeakers | null> {
  const event = await prisma.event.findFirst({
    where: { OR: [{ id: eventParam }, { slug: eventParam }] },
    select: { id: true, name: true, slug: true, timezone: true, startsAt: true, endsAt: true },
  });
  if (!event) return null;

  const publicSessionWhere: Prisma.SessionSpeakerWhereInput = {
    session: {
      eventId: event.id,
      scheduleSlot: { isNot: null },
      OR: [
        { sourceAbstractId: null },
        { sourceAbstract: { is: { status: "ACCEPTED" } } },
      ],
    },
  };
  const speakers = await prisma.user.findMany({
    where: { sessionSpeakers: { some: publicSessionWhere } },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: PUBLIC_SPEAKER_LIMITS.speakers + 1,
    select: {
      id: true,
      name: true,
      avatarUrl: true,
      speakerProfile: {
        select: { bio: true, company: true, jobTitle: true, headshotUrl: true },
      },
      sessionSpeakers: {
        where: publicSessionWhere,
        orderBy: [{ session: { scheduleSlot: { startsAt: "asc" } } }, { sessionId: "asc" }],
        take: PUBLIC_SPEAKER_LIMITS.sessionsPerSpeaker + 1,
        select: {
          session: {
            select: {
              id: true,
              title: true,
              scheduleSlot: { select: { track: { select: { name: true } } } },
            },
          },
        },
      },
    },
  });

  return buildPublicSpeakers(event, speakers);
});

// ---- Embeds ---------------------------------------------------------------

export type EmbedTargets = {
  event: { id: string; name: string; slug: string };
  scheduledSessions: number;
  publicSpeakers: number;
};

/**
 * Admin-only metadata for `/admin/embeds`: which event the snippets point at
 * and how much public content each embed currently renders (so the page can
 * warn when an embed would look empty to a visitor).
 */
export async function getEmbedTargets(): Promise<EmbedTargets> {
  const ctx = await pageContext(["ADMIN"]);
  const [event, scheduledSessions, publicSpeakers] = await Promise.all([
    prisma.event.findUniqueOrThrow({
      where: { id: ctx.eventId },
      select: { id: true, name: true, slug: true },
    }),
    prisma.scheduleSlot.count({ where: { eventId: ctx.eventId } }),
    prisma.user.count({
      where: {
        sessionSpeakers: {
          some: {
            session: {
              eventId: ctx.eventId,
              scheduleSlot: { isNot: null },
              OR: [{ sourceAbstractId: null }, { sourceAbstract: { is: { status: "ACCEPTED" } } }],
            },
          },
        },
      },
    }),
  ]);
  return { event, scheduledSessions, publicSpeakers };
}

// ---- Evaluation setup (admin) ---------------------------------------------

export type SetupPlan = {
  id: string;
  name: string;
  ordinal: number;
  isBlind: boolean;
  rubric: RubricCriterionView[];
  assignmentCount: number;
  completedCount: number;
};

export type SetupEvaluator = {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  /** Assignments in each plan, keyed by planId. */
  loadByPlan: Record<string, number>;
};

export type SetupAbstract = {
  id: string;
  title: string;
  status: AbstractStatus;
  categoryId: string | null;
  categoryName: string | null;
  /** Routing team inherited from the abstract's category, if configured. */
  defaultTeamKey: string | null;
  /** Reviewers assigned in each plan, keyed by planId. */
  assignedByPlan: Record<string, number>;
  /** Completed reviews in each plan, keyed by planId. */
  completedByPlan: Record<string, number>;
};

export type EvaluationSetupView = {
  eventId: string;
  plans: SetupPlan[];
  evaluators: SetupEvaluator[];
  abstracts: SetupAbstract[];
  categories: { id: string; name: string; defaultTeamKey: string | null }[];
  /** True when the event has categories but none carry a routing team. */
  routingUnconfigured: boolean;
};

/**
 * Everything the admin evaluation setup panel needs, in five bounded queries.
 *
 * Assignment detail is read as aggregates rather than rows: the panel only ever
 * needs "how many reviewers on this proposal" and "how loaded is this
 * reviewer", and an event with 40 proposals x 5 reviewers x 3 rounds would
 * otherwise materialize 600 rows to render two counts.
 */
export async function getEvaluationSetup(): Promise<EvaluationSetupView> {
  const ctx = await pageContext(["ADMIN"]);

  const [plans, members, abstracts, categories, byAbstract, byEvaluator] = await Promise.all([
    prisma.evaluationPlan.findMany({
      where: { eventId: ctx.eventId },
      orderBy: { ordinal: "asc" },
    }),
    prisma.eventMember.findMany({
      where: { eventId: ctx.eventId, role: { in: ["EVALUATOR", "ADMIN"] } },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { user: { name: "asc" } },
    }),
    prisma.abstract.findMany({
      // DRAFTs are not submissions yet, and terminal states are not reviewable.
      where: {
        eventId: ctx.eventId,
        status: { in: ["SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "REJECTED"] },
      },
      orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        title: true,
        status: true,
        category: { select: { id: true, name: true, defaultTeamKey: true } },
      },
    }),
    prisma.category.findMany({
      where: { eventId: ctx.eventId },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true, defaultTeamKey: true },
    }),
    prisma.reviewAssignment.groupBy({
      by: ["planId", "abstractId", "status"],
      where: { plan: { eventId: ctx.eventId } },
      _count: { _all: true },
    }),
    prisma.reviewAssignment.groupBy({
      by: ["planId", "evaluatorId"],
      where: { plan: { eventId: ctx.eventId } },
      _count: { _all: true },
    }),
  ]);

  const assignedByPlan = new Map<string, Record<string, number>>();
  const completedByPlan = new Map<string, Record<string, number>>();
  const planTotals = new Map<string, { assigned: number; completed: number }>();
  for (const row of byAbstract) {
    const n = row._count._all;
    const assigned = assignedByPlan.get(row.abstractId) ?? {};
    assigned[row.planId] = (assigned[row.planId] ?? 0) + n;
    assignedByPlan.set(row.abstractId, assigned);

    const totals = planTotals.get(row.planId) ?? { assigned: 0, completed: 0 };
    totals.assigned += n;
    if (row.status === "COMPLETED") {
      totals.completed += n;
      const completed = completedByPlan.get(row.abstractId) ?? {};
      completed[row.planId] = (completed[row.planId] ?? 0) + n;
      completedByPlan.set(row.abstractId, completed);
    }
    planTotals.set(row.planId, totals);
  }

  const loadByEvaluator = new Map<string, Record<string, number>>();
  for (const row of byEvaluator) {
    const load = loadByEvaluator.get(row.evaluatorId) ?? {};
    load[row.planId] = row._count._all;
    loadByEvaluator.set(row.evaluatorId, load);
  }

  return {
    eventId: ctx.eventId,
    plans: plans.map((p) => {
      const totals = planTotals.get(p.id) ?? { assigned: 0, completed: 0 };
      return {
        id: p.id,
        name: p.name,
        ordinal: p.ordinal,
        isBlind: p.isBlind,
        rubric: Array.isArray(p.rubric) ? (p.rubric as unknown as RubricCriterionView[]) : [],
        assignmentCount: totals.assigned,
        completedCount: totals.completed,
      };
    }),
    evaluators: members.map((m) => ({
      userId: m.user.id,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      loadByPlan: loadByEvaluator.get(m.user.id) ?? {},
    })),
    abstracts: abstracts.map((a) => ({
      id: a.id,
      title: a.title,
      status: a.status,
      categoryId: a.category?.id ?? null,
      categoryName: a.category?.name ?? null,
      defaultTeamKey: a.category?.defaultTeamKey ?? null,
      assignedByPlan: assignedByPlan.get(a.id) ?? {},
      completedByPlan: completedByPlan.get(a.id) ?? {},
    })),
    categories,
    routingUnconfigured: categories.length > 0 && categories.every((c) => !c.defaultTeamKey),
  };
}
