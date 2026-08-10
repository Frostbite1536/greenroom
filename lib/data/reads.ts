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
 *   getPublicForm()       ~ GET /api/cfp/public/:eventSlug/:formSlug
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
import { ApiError } from "@/lib/api/http";
import { assertEventQueryBound, OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import {
  ADMIN_ABSTRACT_LIST_TAKE,
  adminAbstractListOrderBy,
  adminAbstractListWhere,
  toAdminAbstractListEnvelope,
} from "@/lib/api/admin-abstract-list";
import {
  getAdminDecisionSummary,
  type AdminDecisionAbstractSummary,
  type AdminDecisionSummary,
} from "@/lib/services/admin-decision-summary";
export type { AdminDecisionAbstractSummary, AdminDecisionSummary } from "@/lib/services/admin-decision-summary";
import {
  EMAIL_HISTORY_TAKE,
  emailHistoryOrderBy,
  emailHistorySelect,
  emailHistoryWhere,
  toEmailHistory,
  type EmailHistory,
} from "@/lib/comms/email-history";
export type { EmailHistoryEntry } from "@/lib/comms/email-history";
import { selectEvaluatorReviewComment } from "@/lib/services/review-score-comment";
import {
  canonicalPublicFormPath,
  resolvePublishedPublicForm,
} from "@/lib/services/public-form-resolver";
import {
  EVALUATION_SETUP_VISIBLE_STATUSES,
  isEvaluationSetupAssignable,
} from "@/lib/evaluation-setup-status";
import {
  isReviewerInvitePending,
  reviewerInviteResendAvailableAt,
} from "@/lib/services/reviewer-invite";
import { serializeForm, serializePublicForm } from "@/lib/api/form-serialize";
import { parseFieldOptions } from "@/lib/services/field-visibility";
import { zonedParts } from "@/lib/tz";
import {
  buildPublicSpeakers,
  PUBLIC_SPEAKER_LIMITS,
  type PublicSpeakers,
} from "@/lib/public-speakers";
import { PUBLIC_AGENDA_LIMITS } from "@/lib/embed-schedule-view";

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

export async function getFormsList(): Promise<{ eventId: string; eventSlug: string; forms: FormListItem[] }> {
  const ctx = await pageContext(["ADMIN"]);
  const [forms, grouped, event] = await Promise.all([
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
    prisma.event.findUnique({ where: { id: ctx.eventId }, select: { slug: true } }),
  ]);
  if (!event) throw new Error("Active event is unavailable.");

  const now = Date.now();
  return {
    eventId: ctx.eventId,
    eventSlug: event.slug,
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

export async function getFormForBuilder(formId: string): Promise<{
  eventId: string;
  timezone: string;
  publicFormPath: string;
  form: BuilderForm;
  /**
   * The event's own categories, so the builder's live preview can answer the
   * built-in Topic category question the same way a submitter does. Same
   * bounded, event-scoped projection the settings read uses, and id + name
   * only — the preview needs what the public picker shows and nothing else.
   */
  categories: { id: string; name: string }[];
} | null> {
  const ctx = await pageContext(["ADMIN"]);
  const [form, event, categories] = await Promise.all([
    prisma.formConfig.findFirst({
      where: { id: formId, eventId: ctx.eventId },
      include: { fields: true },
    }),
    prisma.event.findUnique({ where: { id: ctx.eventId }, select: { timezone: true, slug: true } }),
    prisma.category.findMany({
      where: { eventId: ctx.eventId },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
      take: OPERATOR_QUERY_LIMITS.settingsCategories + 1,
      select: { id: true, name: true },
    }),
  ]);
  if (!form || !event) return null;
  assertEventQueryBound(categories, OPERATOR_QUERY_LIMITS.settingsCategories, "categories in the form builder");
  const serialized = serializeForm(form);
  return {
    eventId: ctx.eventId,
    timezone: event.timezone,
    publicFormPath: canonicalPublicFormPath({ eventSlug: event.slug, formSlug: serialized.slug }),
    form: { ...serialized, fields: form.fields.slice().sort((a, b) => a.sortOrder - b.sortOrder).map(normalizeField) },
    categories: categories.slice(0, OPERATOR_QUERY_LIMITS.settingsCategories),
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

type StoredAnswerProjection = {
  abstractId: string;
  value: unknown;
  formField: {
    id: string;
    label: string;
    type: FormFieldType;
    options: unknown;
  };
};

type AnswerCountGroup = {
  abstractId: string;
  _count: { _all: number };
};

/** A de-identified evaluator note available only to an organizer projection. */
export type OrganizerReviewComment = {
  /** One text normally; multiple strings preserve divergent legacy criteria honestly. */
  comments: string[];
};

type StoredReviewCommentProjection = {
  abstractId: string;
  evaluatorId: string;
  rubricKey: string;
  comment: string | null;
};

/**
 * Keep raw evaluator comments out of shared/evaluator reads. Returning null,
 * rather than an empty map, lets the serializer omit the field entirely for a
 * non-admin caller.
 */
export function indexOrganizerReviewComments(
  role: string,
  rows: readonly StoredReviewCommentProjection[],
  limit: number = OPERATOR_QUERY_LIMITS.adminReviewComments,
): Map<string, OrganizerReviewComment[]> | null {
  if (role !== "ADMIN") return null;
  assertEventQueryBound(rows, limit, "review comments in the organizer view");

  const byReview = new Map<string, { abstractId: string; comments: string[] }>();
  for (const row of rows) {
    // Prisma retains nullable field types even with `not: null` in the query.
    // Keep the projection defensively safe if the query ever changes.
    if (row.comment === null) continue;

    const key = `${row.abstractId}\u0000${row.evaluatorId}`;
    const existing = byReview.get(key);
    if (existing) {
      if (!existing.comments.includes(row.comment)) existing.comments.push(row.comment);
      continue;
    }
    byReview.set(key, { abstractId: row.abstractId, comments: [row.comment] });
  }

  const byAbstract = new Map<string, OrganizerReviewComment[]>();
  for (const review of byReview.values()) {
    const comments = byAbstract.get(review.abstractId) ?? [];
    comments.push({ comments: review.comments });
    byAbstract.set(review.abstractId, comments);
  }
  return byAbstract;
}

/**
 * Give each materialized proposal an all-or-nothing share of the page's answer
 * budget. A proposal that cannot fit is marked unavailable, while later small
 * proposals can still use the remaining budget. This keeps one answer flood
 * from blanking unrelated proposal drawers.
 */
export function planAdminAnswerRead(
  abstractIds: readonly string[],
  counts: readonly AnswerCountGroup[],
  limit = ADMIN_ANSWER_LIMIT,
): {
  queryAbstractIds: string[];
  expectedAnswerCounts: Map<string, number>;
  unavailableAbstractIds: Set<string>;
} {
  const countByAbstract = new Map(counts.map((count) => [count.abstractId, count._count._all]));
  const queryAbstractIds: string[] = [];
  const expectedAnswerCounts = new Map<string, number>();
  const unavailableAbstractIds = new Set<string>();
  let remaining = limit;

  for (const abstractId of abstractIds) {
    const answerCount = countByAbstract.get(abstractId) ?? 0;
    if (answerCount <= remaining) {
      queryAbstractIds.push(abstractId);
      expectedAnswerCounts.set(abstractId, answerCount);
      remaining -= answerCount;
    } else if (answerCount > 0) {
      unavailableAbstractIds.add(abstractId);
    }
  }

  return { queryAbstractIds, expectedAnswerCounts, unavailableAbstractIds };
}

/** Build an answer index without ever exposing a partial proposal. */
export function indexAdminAnswers(
  rows: readonly StoredAnswerProjection[],
  expectedAnswerCounts: ReadonlyMap<string, number>,
  unavailableAbstractIds: ReadonlySet<string> = new Set(),
): { unavailableAbstractIds: Set<string>; byAbstract: Map<string, AnswerRow[]> } {
  const unavailable = new Set(unavailableAbstractIds);
  const rowsByAbstract = new Map<string, StoredAnswerProjection[]>();
  for (const row of rows) {
    const group = rowsByAbstract.get(row.abstractId) ?? [];
    group.push(row);
    rowsByAbstract.set(row.abstractId, group);
  }

  // A concurrent answer write can make the bounded row query contain one more
  // answer than the count plan. Compare each proposal independently, so only
  // the changing/truncated proposal is withheld; unaffected exact sets remain
  // available and no proposal is rendered partially.
  for (const [abstractId, expectedCount] of expectedAnswerCounts) {
    if ((rowsByAbstract.get(abstractId)?.length ?? 0) !== expectedCount) {
      unavailable.add(abstractId);
    }
  }

  const byAbstract = new Map<string, AnswerRow[]>();
  for (const [abstractId, abstractRows] of rowsByAbstract) {
    if (unavailable.has(abstractId)) continue;
    byAbstract.set(abstractId, abstractRows.map((row) => ({
      fieldId: row.formField.id,
      label: row.formField.label,
      type: row.formField.type,
      options: parseFieldOptions(row.formField.options),
      value: row.value,
    })));
  }
  return { unavailableAbstractIds: unavailable, byAbstract };
}

export type AbstractRow = {
  id: string;
  title: string;
  abstract: string | null;
  status: AbstractStatus;
  format: string | null;
  durationMinutes: number | null;
  categoryName: string | null;
  formName: string;
  /** `role` is the per-proposal contribution label ("Co-presenter"), or null. */
  speakers: { name: string; isPrimary: boolean; role: string | null }[];
  submittedAt: string | null;
  /** Server-computed only for the explicitly selected decision round. */
  decisionSummary: AdminDecisionAbstractSummary | null;
  /** Custom CFP answers, in form order. Empty when the form had no extra questions. */
  answers: AnswerRow[];
  /**
   * True when this event has more stored answers than one page read will
   * materialize, so this row's answers were not loaded. Surfaced in the UI
   * rather than silently showing an empty section.
   */
  answersUnavailable: boolean;
  /** Present only in the organizer/admin projection; evaluator payloads omit it. */
  reviewComments?: OrganizerReviewComment[];
  hasSession: boolean;
  /** The confirmed talk created from this proposal, if conversion has happened. */
  sessionId: string | null;
  /** True when that talk also holds a schedule slot, i.e. it is on the public programme. */
  sessionScheduled: boolean;
};

type AbstractStatusCountGroup = {
  status: AbstractStatus;
  _count: { _all: number };
};

export function summarizeAdminAbstractMetrics(groups: readonly AbstractStatusCountGroup[]) {
  let total = 0;
  let accepted = 0;
  let pending = 0;
  for (const group of groups) {
    const count = group._count._all;
    total += count;
    if (group.status === "ACCEPTED") accepted += count;
    if (group.status === "SUBMITTED" || group.status === "UNDER_REVIEW" || group.status === "MAYBE") {
      pending += count;
    }
  }
  return { total, accepted, pending };
}

export type AdminAbstractsView = {
  eventId: string;
  /** The newest bounded page only; client tabs/search intentionally apply here. */
  abstracts: AbstractRow[];
  /** An older, event-scoped deep-link target rendered only in its drawer. */
  selectedAbstract: AbstractRow | null;
  total: number;
  hasMore: boolean;
  metrics: { total: number; accepted: number; pending: number };
  decisionSummary: AdminDecisionSummary;
};

const adminAbstractSelect = {
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
    // Email is not needed for this organizer surface, so it never enters the
    // RSC payload.
    select: { isPrimary: true, role: true, user: { select: { name: true } } },
  },
  // `scheduleSlot` tells the admin table whether the confirmed talk is
  // actually on the public programme, which is what makes a reversed
  // decision consequential (INV-DOMAIN-001: we never auto-delete it).
  session: { select: { id: true, scheduleSlot: { select: { id: true } } } },
} satisfies Prisma.AbstractSelect;

// The bounded parent page, its global metrics, and any selected deep-link row
// must describe one database moment. Child collections intentionally run after
// this short snapshot because they are scoped by its at-most-101 known IDs.
export const ADMIN_ABSTRACT_SNAPSHOT_OPTIONS = {
  isolationLevel: "RepeatableRead",
} as const;

export async function getAdminAbstracts(
  requestedAbstractId?: string | null,
  planId?: string | null,
): Promise<AdminAbstractsView> {
  const ctx = await pageContext(["ADMIN"]);
  const parentWhere = adminAbstractListWhere({ eventId: ctx.eventId });

  // The parent page, its global summary, and one optional deep link start
  // together inside one short snapshot. That prevents an overflow indicator
  // from describing a different event state than the table it accompanies.
  const { parentRows, statusGroups, requestedAbstract } = await prisma.$transaction(async (tx) => {
    const [parentRows, statusGroups, requestedAbstract] = await Promise.all([
      tx.abstract.findMany({
        where: parentWhere,
        orderBy: adminAbstractListOrderBy,
        take: ADMIN_ABSTRACT_LIST_TAKE,
        select: adminAbstractSelect,
      }),
      tx.abstract.groupBy({
        by: ["status"],
        where: parentWhere,
        _count: { _all: true },
      }),
      requestedAbstractId
        ? tx.abstract.findFirst({
            where: { ...parentWhere, id: requestedAbstractId },
            select: adminAbstractSelect,
          })
        : Promise.resolve(null),
    ]);
    return { parentRows, statusGroups, requestedAbstract };
  }, ADMIN_ABSTRACT_SNAPSHOT_OPTIONS);

  const metrics = summarizeAdminAbstractMetrics(statusGroups);
  const newest = toAdminAbstractListEnvelope(parentRows, metrics.total);
  const newestIds = newest.abstracts.map((abstract) => abstract.id);
  const selectedParent = requestedAbstract && !newestIds.includes(requestedAbstract.id)
    ? requestedAbstract
    : null;
  // A selected older proposal is materialized only for its drawer. It never
  // changes the newest-page list, its tab counts, or the overflow notice.
  const materializedAbstracts = selectedParent
    ? [...newest.abstracts, selectedParent]
    : newest.abstracts;
  const materializedIds = materializedAbstracts.map((abstract) => abstract.id);

  if (materializedIds.length === 0) {
    const decisionSummary = await getAdminDecisionSummary(ctx, {
      abstractIds: materializedIds,
      ...(planId ? { planId } : {}),
    });
    return {
      eventId: ctx.eventId,
      abstracts: [],
      selectedAbstract: null,
      total: newest.total,
      hasMore: newest.hasMore,
      metrics,
      decisionSummary,
    };
  }

  const childWhere = { abstractId: { in: materializedIds } };
  // Child collections are deliberately scoped to the at-most-100 newest rows
  // plus the one event-scoped drawer target. Nothing below scans a flooded
  // event-wide answer/review/assignment collection.
  const answerCountsPromise = prisma.formAnswer.groupBy({
    by: ["abstractId"],
    where: childWhere,
    _count: { _all: true },
  });
  const reviewCommentRowsPromise: Promise<StoredReviewCommentProjection[]> = prisma.reviewScore.findMany({
    where: { ...childWhere, comment: { not: null } },
    orderBy: [{ abstractId: "asc" }, { evaluatorId: "asc" }, { rubricKey: "asc" }, { id: "asc" }],
    take: OPERATOR_QUERY_LIMITS.adminReviewComments + 1,
    select: { abstractId: true, evaluatorId: true, rubricKey: true, comment: true },
  });
  // Await the plan-scoped service alongside the independent bounded child
  // reads. An invalid explicit plan id is therefore handled by the page's 404
  // boundary immediately, never left to reject while an answer read is still
  // in flight.
  const [answerCounts, decisionSummary, reviewCommentRows] = await Promise.all([
    answerCountsPromise,
    getAdminDecisionSummary(ctx, {
      abstractIds: materializedIds,
      ...(planId ? { planId } : {}),
    }),
    reviewCommentRowsPromise,
  ]);

  const answerPlan = planAdminAnswerRead(materializedIds, answerCounts);
  const answerRowsPromise: Promise<StoredAnswerProjection[]> = answerPlan.queryAbstractIds.length > 0
    ? prisma.formAnswer.findMany({
        where: { abstractId: { in: answerPlan.queryAbstractIds } },
        orderBy: [
          { abstractId: "asc" },
          { formField: { sortOrder: "asc" } },
          { formFieldId: "asc" },
        ],
        take: ADMIN_ANSWER_LIMIT + 1,
        select: {
          abstractId: true,
          value: true,
          formField: { select: { id: true, label: true, type: true, options: true } },
        },
      })
    : Promise.resolve([]);

  const answerRows = await answerRowsPromise;

  const answerIndex = indexAdminAnswers(
    answerRows,
    answerPlan.expectedAnswerCounts,
    answerPlan.unavailableAbstractIds,
  );
  const reviewCommentsByAbstract = indexOrganizerReviewComments("ADMIN", reviewCommentRows);

  const rowsById = new Map(materializedAbstracts.map((a) => {
    const row: AbstractRow = {
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
        isPrimary: s.isPrimary,
        role: s.role,
      })),
      submittedAt: a.submittedAt?.toISOString() ?? null,
      decisionSummary: decisionSummary.summariesByAbstractId[a.id] ?? null,
      answers: answerIndex.byAbstract.get(a.id) ?? [],
      answersUnavailable: answerIndex.unavailableAbstractIds.has(a.id),
      reviewComments: reviewCommentsByAbstract?.get(a.id) ?? [],
      hasSession: a.session !== null,
      sessionId: a.session?.id ?? null,
      sessionScheduled: a.session?.scheduleSlot != null,
    };
    return [a.id, row] as const;
  }));

  return {
    eventId: ctx.eventId,
    abstracts: newestIds.map((id) => rowsById.get(id)!),
    selectedAbstract: selectedParent ? rowsById.get(selectedParent.id)! : null,
    total: newest.total,
    hasMore: newest.hasMore,
    metrics,
    decisionSummary,
  };
}

// ---- Agenda ---------------------------------------------------------------

export type AgendaSession = {
  id: string;
  title: string;
  format: string | null;
  durationMinutes: number;
  /** The proposal's topic, carried onto the talk at acceptance. Null for a
   *  directly authored session, or once its category is deleted. */
  category: { id: string; name: string } | null;
  /** Whether this talk is announced on the public programme. */
  contentStatus: "DRAFT" | "PUBLISHED";
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
  /** True when the event holds more sessions than one read materializes (S20).
   *  The builder says so rather than laying out a partial programme silently. */
  truncated: boolean;
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
      // Bounded, stably ordered, cap-plus-one (S20). `id` breaks `createdAt`
      // ties so the grid cannot reshuffle between renders. The builder reports
      // the cut rather than silently laying out a partial programme — a
      // conflict it never loaded is a conflict it cannot warn about.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: OPERATOR_QUERY_LIMITS.agendaSessions + 1,
      select: {
        id: true,
        title: true,
        format: true,
        durationMinutes: true,
        category: { select: { id: true, name: true } },
        contentStatus: true,
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
    truncated: sessions.length > OPERATOR_QUERY_LIMITS.agendaSessions,
    sessions: sessions.slice(0, OPERATOR_QUERY_LIMITS.agendaSessions).map((s) => ({
      id: s.id,
      title: s.title,
      format: s.format,
      durationMinutes: s.durationMinutes,
      category: s.category,
      contentStatus: s.contentStatus,
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
  /** The proposal's own status: a speaker can withdraw mid-review (W1). */
  abstractStatus: AbstractStatus;
  speakers: string[];
  myScores: Record<string, number>;
  myComment: string | null;
};

/**
 * One selectable round, carrying the caller's *own* assignment count.
 *
 * `assignedToMe` is deliberately the only per-round volume exposed here: it is
 * the same self-scoped set the queue below projects, so the selector can make
 * other rounds discoverable without widening whose assignments are readable.
 */
export type EvaluationRoundOption = {
  id: string;
  name: string;
  ordinal: number;
  assignedToMe: number;
};

export type EvaluationView = {
  eventId: string;
  role: string;
  /** Every round of this event, newest ordinal first. Empty when none exist. */
  rounds: EvaluationRoundOption[];
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
 * Choose which round the reviewer lands on.
 *
 * This read used to pin to the highest-ordinal round, which made an assignment
 * held in any earlier round completely invisible to the reviewer who held it.
 * The default is now the newest round the caller actually has work in, so no
 * assignment is silently hidden; an explicit request always wins, which keeps a
 * round the caller holds nothing in reachable from the selector.
 *
 * `rounds` must already be ordered newest-first.
 */
export function resolveEvaluationRound(
  rounds: readonly EvaluationRoundOption[],
  requestedPlanId?: string | null,
): EvaluationRoundOption | null {
  const planId = requestedPlanId?.trim() || null;
  if (planId) {
    const requested = rounds.find((round) => round.id === planId);
    if (!requested) throw new ApiError(404, "PLAN_NOT_FOUND", "Plan not found.");
    return requested;
  }
  return rounds.find((round) => round.assignedToMe > 0) ?? rounds[0] ?? null;
}

/**
 * The scoring queue for the signed-in reviewer.
 *
 * Always filtered to the caller's own assignments: `POST /api/evaluations/scores`
 * rejects an unassigned reviewer with `NOT_ASSIGNED`, so showing another
 * reviewer's rows would render an unusable form.
 */
export async function getEvaluationQueue(requestedPlanId?: string | null): Promise<EvaluationView> {
  const ctx = await pageContext(["ADMIN", "EVALUATOR"]);

  const [planRows, myRoundCounts] = await Promise.all([
    prisma.evaluationPlan.findMany({
      where: { eventId: ctx.eventId },
      // Metadata only: the selected round's rubric JSON is read separately
      // below rather than materializing every round's blob for the selector.
      select: { id: true, name: true, ordinal: true },
      orderBy: [{ ordinal: "desc" }, { id: "asc" }],
      // The event's rounds are the same bounded set the decision summary caps.
      take: OPERATOR_QUERY_LIMITS.adminDecisionPlans + 1,
    }),
    // Self-scoped exactly like the queue: this widens which rounds are
    // projected, never whose assignments are counted or shown.
    prisma.reviewAssignment.groupBy({
      by: ["planId"],
      where: { evaluatorId: ctx.userId, plan: { eventId: ctx.eventId } },
      _count: { _all: true },
    }),
  ]);
  assertEventQueryBound(planRows, OPERATOR_QUERY_LIMITS.adminDecisionPlans, "evaluation plans");

  const countByPlanId = new Map(myRoundCounts.map((row) => [row.planId, row._count._all]));
  const rounds: EvaluationRoundOption[] = planRows.map((row) => ({
    id: row.id,
    name: row.name,
    ordinal: row.ordinal,
    assignedToMe: countByPlanId.get(row.id) ?? 0,
  }));

  const selectedRound = resolveEvaluationRound(rounds, requestedPlanId);
  const plan = selectedRound
    ? await prisma.evaluationPlan.findFirst({
        where: { id: selectedRound.id, eventId: ctx.eventId },
        include: { _count: { select: { assignments: true } } },
      })
    : null;
  if (!plan) {
    return { eventId: ctx.eventId, role: ctx.role, rounds, plan: null, queue: [] };
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
            status: true,
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

  const scoresByAbstract = new Map<string, { scores: Record<string, number>; commentsByRubric: Map<string, string | null> }>();
  for (const row of myScores) {
    const entry: { scores: Record<string, number>; commentsByRubric: Map<string, string | null> } =
      scoresByAbstract.get(row.abstractId) ?? { scores: {}, commentsByRubric: new Map() };
    entry.scores[row.rubricKey] = Number(row.score);
    entry.commentsByRubric.set(row.rubricKey, row.comment);
    scoresByAbstract.set(row.abstractId, entry);
  }

  const rubric = Array.isArray(plan.rubric) ? (plan.rubric as unknown as RubricCriterionView[]) : [];
  const blind = plan.isBlind && ctx.role === "EVALUATOR";

  return {
    eventId: ctx.eventId,
    role: ctx.role,
    rounds,
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
        abstractStatus: a.abstract.status,
        speakers: blind ? [] : a.abstract.speakers.map((s) => s.user.name),
        myScores: mine?.scores ?? {},
        myComment: selectEvaluatorReviewComment(
          rubric.map((criterion) => criterion.key),
          mine ? [...mine.commentsByRubric].map(([rubricKey, comment]) => ({ rubricKey, comment })) : [],
        ),
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
 * Canonical public CFP form by event and form slug. No session required.
 *
 * The shared Backend resolver loads the event-owned categories with the form,
 * so this RSC projection cannot reintroduce the old unscoped slug lookup or an
 * N+1 category read.
 */
export const getPublicForm = cache(async function getPublicForm(
  eventSlug: string,
  formSlug: string,
): Promise<PublicFormView | null> {
  const form = await resolvePublishedPublicForm({ eventSlug, formSlug });
  if (!form) return null;

  const serialized = serializePublicForm(form);
  return {
    ...serialized,
    fields: form.fields.slice().sort((a, b) => a.sortOrder - b.sortOrder).map(normalizeField),
    categories: serialized.categories,
    eventName: form.event.name,
  };
});

export type PublicAgendaSession = {
  slotId: string;
  sessionId: string;
  title: string;
  description: string | null;
  /** Public session format label ("Keynote", "Workshop"), already exposed by
   *  GET /api/agenda/public; the server-rendered embed needs it for its chips. */
  format: string | null;
  room: { id: string; name: string };
  track: { id: string; name: string; color: string } | null;
  /** The proposal's topic, carried onto the talk at acceptance (`Session.categoryId`).
   *  Independent of `track`, which is a schedule swimlane owned by the slot. */
  category: { id: string; name: string } | null;
  startsAt: string;
  endsAt: string;
  speakers: string[];
};

export type PublicAgenda = {
  event: { id: string; name: string; slug: string; timezone: string; startsAt: string | null; endsAt: string | null };
  tracks: { id: string; name: string; color: string }[];
  sessions: PublicAgendaSession[];
  /** True when this event holds more published placed sessions than one read
   *  materializes (S20). Surfaced to the reader rather than silently cutting. */
  truncated: boolean;
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
      // A talk reaches the public programme only while it is published. An
      // unpublished session keeps its slot, its speakers and its place in the
      // admin grid — it simply stops being announced (CNT-12, AIA-07).
      where: { eventId: event.id, session: { contentStatus: "PUBLISHED" } },
      // Bounded, stably ordered, cap-plus-one (S20). `id` breaks ties so two
      // sessions starting at the same instant cannot swap places between
      // renders and silently change which one falls outside the cap.
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      take: PUBLIC_AGENDA_LIMITS.sessions + 1,
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
            format: true,
            category: { select: { id: true, name: true } },
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
    truncated: slots.length > PUBLIC_AGENDA_LIMITS.sessions,
    sessions: slots.slice(0, PUBLIC_AGENDA_LIMITS.sessions).map((slot) => ({
      slotId: slot.id,
      sessionId: slot.sessionId,
      title: slot.session.title,
      description: slot.session.description,
      format: slot.session.format,
      room: slot.room,
      track: slot.track,
      category: slot.session.category,
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
      // The same publication predicate the schedule uses: unpublishing a talk
      // must not leave its speaker announced on the public gallery.
      contentStatus: "PUBLISHED",
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
              scheduleSlot: {
                select: {
                  track: { select: { name: true } },
                  startsAt: true,
                  endsAt: true,
                  room: { select: { name: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  return buildPublicSpeakers(event, speakers);
});

// ---- Email history --------------------------------------------------------

export type EmailHistoryView = EmailHistory & {
  /** Every timestamp on the panel is rendered in the event's own timezone. */
  timezone: string;
};

/**
 * Admin-only read behind `/admin/emails`.
 *
 * `EmailDispatch` rows have existed since the audited send path landed but had
 * no reader, so an operator had no way to confirm a reminder, decision mail, or
 * reviewer invite actually left — and a bulk send reporting failures named
 * neither the recipients nor the reasons. This is a bounded newest-first page
 * over that log; the projection and the delivery wording live in
 * `lib/comms/email-history.ts`.
 *
 * Unlike the fail-closed operator reads, an oversize log is expected here: the
 * table only grows, so the page reports its truncation instead of refusing.
 *
 * One cap-plus-one query answers everything the panel says about volume. It is
 * deliberately not paired with a `count()` for an exact event-wide total: the
 * two statements observe different snapshots, so a dispatch inserted between
 * them let the page print a total that disagreed with its own rows. Dropping
 * the count removes that contradiction outright rather than shrinking its
 * window behind a `RepeatableRead` transaction.
 */
export async function getEmailHistory(): Promise<EmailHistoryView> {
  const ctx = await pageContext(["ADMIN"]);
  const [event, rows] = await Promise.all([
    prisma.event.findUniqueOrThrow({ where: { id: ctx.eventId }, select: { timezone: true } }),
    prisma.emailDispatch.findMany({
      where: emailHistoryWhere(ctx.eventId),
      select: emailHistorySelect,
      orderBy: emailHistoryOrderBy,
      take: EMAIL_HISTORY_TAKE,
    }),
  ]);
  return { ...toEmailHistory(rows), timezone: event.timezone };
}

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

// ---- Event settings -------------------------------------------------------

export type EventSettingsView = {
  event: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    /** Event-calendar dates, not instants in the administrator's browser timezone. */
    startsOn: string | null;
    endsOn: string | null;
  };
  rooms: { id: string; name: string; capacity: number | null; sortOrder: number }[];
  tracks: { id: string; name: string; color: string; sortOrder: number }[];
  categories: {
    id: string;
    name: string;
    description: string | null;
    defaultTeamKey: string | null;
    sortOrder: number;
  }[];
};

/** The server read mirrors GET /api/admin/settings without an internal HTTP hop. */
export async function getEventSettings(): Promise<EventSettingsView> {
  const ctx = await pageContext(["ADMIN"]);
  const settingsOrder = [{ sortOrder: "asc" as const }, { name: "asc" as const }, { id: "asc" as const }];
  const [event, rooms, tracks, categories] = await Promise.all([
    prisma.event.findUniqueOrThrow({
      where: { id: ctx.eventId },
      select: { id: true, name: true, slug: true, timezone: true, startsAt: true, endsAt: true },
    }),
    prisma.room.findMany({
      where: { eventId: ctx.eventId },
      orderBy: settingsOrder,
      take: OPERATOR_QUERY_LIMITS.settingsRooms + 1,
      select: { id: true, name: true, capacity: true, sortOrder: true },
    }),
    prisma.track.findMany({
      where: { eventId: ctx.eventId },
      orderBy: settingsOrder,
      take: OPERATOR_QUERY_LIMITS.settingsTracks + 1,
      select: { id: true, name: true, color: true, sortOrder: true },
    }),
    prisma.category.findMany({
      where: { eventId: ctx.eventId },
      orderBy: settingsOrder,
      take: OPERATOR_QUERY_LIMITS.settingsCategories + 1,
      select: { id: true, name: true, description: true, defaultTeamKey: true, sortOrder: true },
    }),
  ]);
  assertEventQueryBound(rooms, OPERATOR_QUERY_LIMITS.settingsRooms, "rooms in event settings");
  assertEventQueryBound(tracks, OPERATOR_QUERY_LIMITS.settingsTracks, "tracks in event settings");
  assertEventQueryBound(categories, OPERATOR_QUERY_LIMITS.settingsCategories, "categories in event settings");

  return {
    event: {
      id: event.id,
      name: event.name,
      slug: event.slug,
      timezone: event.timezone,
      startsOn: event.startsAt ? zonedParts(event.startsAt.toISOString(), event.timezone).dateKey : null,
      endsOn: event.endsAt ? zonedParts(event.endsAt.toISOString(), event.timezone).dateKey : null,
    },
    rooms,
    tracks,
    categories,
  };
}

// ---- Evaluation setup (admin) ---------------------------------------------

export type SetupPlan = {
  id: string;
  name: string;
  ordinal: number;
  isBlind: boolean;
  /**
   * The round's optional review window, as stored instants. Rendered in the
   * event's timezone by `formatRoundWindow`; nothing gates on it.
   */
  startsAt: string | null;
  endsAt: string | null;
  rubric: RubricCriterionView[];
  assignmentCount: number;
  completedCount: number;
};

export type SetupEvaluator = {
  userId: string;
  name: string;
  /** ADMIN-only contact data is required for the explicit resend action. */
  email: string;
  role: UserRole;
  /** Explicit membership is ready before an invitation is accepted. */
  access: "active";
  /** Token-free lifecycle data, scoped to this bounded event-member page. */
  invite: {
    state: "pending" | "accepted" | "expired";
    expiresAt: string;
    resendAvailableAt: string | null;
    delivery: "not_sent" | "pending" | "mocked" | "sent" | "failed";
  } | null;
  /** Assignments in each plan, keyed by planId. */
  loadByPlan: Record<string, number>;
};

export type SetupAbstract = {
  id: string;
  title: string;
  status: AbstractStatus;
  /** Mirrors the S5 write contract; terminal proposals remain coverage-only. */
  assignable: boolean;
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
  /** Round windows are authored and rendered as event-local calendar dates. */
  timezone: string;
  plans: SetupPlan[];
  evaluators: SetupEvaluator[];
  abstracts: SetupAbstract[];
  categories: { id: string; name: string; defaultTeamKey: string | null }[];
  /** True when the event has categories but none carry a routing team. */
  routingUnconfigured: boolean;
};

/**
 * Everything the admin evaluation setup panel needs, in bounded event-scoped
 * projection/aggregate queries.
 *
 * Assignment detail is read as aggregates rather than rows: the panel only ever
 * needs "how many reviewers on this proposal" and "how loaded is this
 * reviewer", and an event with 40 proposals x 5 reviewers x 3 rounds would
 * otherwise materialize 600 rows to render two counts.
 */
export async function getEvaluationSetup(): Promise<EvaluationSetupView> {
  const ctx = await pageContext(["ADMIN"]);

  const membersPromise = prisma.eventMember.findMany({
    where: { eventId: ctx.eventId, role: { in: ["EVALUATOR", "ADMIN"] } },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { user: { name: "asc" } },
    take: OPERATOR_QUERY_LIMITS.reviewerSetupMembers + 1,
  });
  const [plans, members, abstracts, categories, byAbstract, byEvaluator, event] = await Promise.all([
    prisma.evaluationPlan.findMany({
      where: { eventId: ctx.eventId },
      orderBy: { ordinal: "asc" },
    }),
    membersPromise,
    prisma.abstract.findMany({
      // DRAFTs are not submissions. Decisions and withdrawals remain visible
      // for historical coverage, but `assignable` keeps them out of the picker.
      where: {
        eventId: ctx.eventId,
        status: { in: EVALUATION_SETUP_VISIBLE_STATUSES },
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
      // Withdrawn work can no longer be scored and must not inflate a
      // reviewer's active load.
      where: { plan: { eventId: ctx.eventId }, abstract: { status: { not: "WITHDRAWN" } } },
      _count: { _all: true },
    }),
    // Round windows are event-local calendar dates, so the panel must render
    // them in the event's timezone rather than the operator's browser zone.
    prisma.event.findUnique({ where: { id: ctx.eventId }, select: { timezone: true } }),
  ]);
  assertEventQueryBound(members, OPERATOR_QUERY_LIMITS.reviewerSetupMembers, "reviewer setup members");

  const memberUserIds = members.map((member) => member.userId);
  const invites = memberUserIds.length === 0
    ? []
    : await prisma.reviewerInvite.findMany({
      where: { eventId: ctx.eventId, userId: { in: memberUserIds } },
      select: {
        userId: true,
        tokenVersion: true,
        expiresAt: true,
        acceptedVersion: true,
        lastSentAt: true,
        lastDeliveryState: true,
      },
      take: OPERATOR_QUERY_LIMITS.reviewerSetupMembers + 1,
    });
  assertEventQueryBound(invites, OPERATOR_QUERY_LIMITS.reviewerSetupMembers, "reviewer setup invites");
  const inviteByUserId = new Map(invites.map((invite) => [invite.userId, invite]));

  const assignedByPlan = new Map<string, Record<string, number>>();
  const completedByPlan = new Map<string, Record<string, number>>();
  const planTotals = new Map<string, { assigned: number; completed: number }>();
  const withdrawnAbstractIds = new Set(
    abstracts.filter((abstract) => abstract.status === "WITHDRAWN").map((abstract) => abstract.id),
  );
  for (const row of byAbstract) {
    const n = row._count._all;
    const assigned = assignedByPlan.get(row.abstractId) ?? {};
    assigned[row.planId] = (assigned[row.planId] ?? 0) + n;
    assignedByPlan.set(row.abstractId, assigned);

    if (row.status === "COMPLETED") {
      const completed = completedByPlan.get(row.abstractId) ?? {};
      completed[row.planId] = (completed[row.planId] ?? 0) + n;
      completedByPlan.set(row.abstractId, completed);
    }

    // A withdrawn proposal remains in historical coverage, but its assignment
    // is no longer actionable and cannot keep round progress below 100%.
    if (!withdrawnAbstractIds.has(row.abstractId)) {
      const totals = planTotals.get(row.planId) ?? { assigned: 0, completed: 0 };
      totals.assigned += n;
      if (row.status === "COMPLETED") totals.completed += n;
      planTotals.set(row.planId, totals);
    }
  }

  const loadByEvaluator = new Map<string, Record<string, number>>();
  for (const row of byEvaluator) {
    const load = loadByEvaluator.get(row.evaluatorId) ?? {};
    load[row.planId] = row._count._all;
    loadByEvaluator.set(row.evaluatorId, load);
  }

  return {
    eventId: ctx.eventId,
    timezone: event?.timezone ?? "UTC",
    plans: plans.map((p) => {
      const totals = planTotals.get(p.id) ?? { assigned: 0, completed: 0 };
      return {
        id: p.id,
        name: p.name,
        ordinal: p.ordinal,
        isBlind: p.isBlind,
        startsAt: p.startsAt?.toISOString() ?? null,
        endsAt: p.endsAt?.toISOString() ?? null,
        rubric: Array.isArray(p.rubric) ? (p.rubric as unknown as RubricCriterionView[]) : [],
        assignmentCount: totals.assigned,
        completedCount: totals.completed,
      };
    }),
    evaluators: members.map((m) => {
      const invite = inviteByUserId.get(m.user.id) ?? null;
      const pending = invite ? isReviewerInvitePending(invite) : false;
      const resendAvailableAt = invite ? reviewerInviteResendAvailableAt(invite.lastSentAt) : null;
      return {
        userId: m.user.id,
        name: m.user.name,
        email: m.user.email,
        role: m.role,
        access: "active" as const,
        invite: invite
          ? {
              state: pending ? "pending" as const : invite.acceptedVersion === invite.tokenVersion ? "accepted" as const : "expired" as const,
              expiresAt: invite.expiresAt.toISOString(),
              resendAvailableAt: resendAvailableAt?.toISOString() ?? null,
              delivery: invite.lastDeliveryState.toLowerCase() as "not_sent" | "pending" | "mocked" | "sent" | "failed",
            }
          : null,
        loadByPlan: loadByEvaluator.get(m.user.id) ?? {},
      };
    }),
    abstracts: abstracts.map((a) => ({
      id: a.id,
      title: a.title,
      status: a.status,
      assignable: isEvaluationSetupAssignable(a.status),
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
