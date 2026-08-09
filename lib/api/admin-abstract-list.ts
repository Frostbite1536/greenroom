import type { AbstractStatus, Prisma } from "@prisma/client";
import { OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";

export type AdminAbstractListFilter = {
  eventId: string;
  statuses?: readonly AbstractStatus[];
  formConfigId?: string;
};

/** One event-scoped filter shared by the bounded parent read and its total. */
export function adminAbstractListWhere(filter: AdminAbstractListFilter): Prisma.AbstractWhereInput {
  return {
    eventId: filter.eventId,
    ...(filter.statuses ? { status: { in: [...filter.statuses] } } : {}),
    ...(filter.formConfigId ? { formConfigId: filter.formConfigId } : {}),
  };
}

/** Stable submitted-first order; `id` breaks equal timestamp ties. */
export const adminAbstractListOrderBy = [
  // PostgreSQL sorts NULL first under a plain DESC. Drafts must trail real
  // submitted proposals so a draft flood cannot consume the newest-page cap.
  { submittedAt: { sort: "desc", nulls: "last" } },
  { createdAt: "desc" },
  { id: "desc" },
] satisfies Prisma.AbstractOrderByWithRelationInput[];

export const ADMIN_ABSTRACT_LIST_TAKE = OPERATOR_QUERY_LIMITS.adminAbstracts + 1;

/** Turn the cap-plus-one parent query into an honest bounded response. */
export function toAdminAbstractListEnvelope<T>(rows: readonly T[], total: number) {
  const cap = OPERATOR_QUERY_LIMITS.adminAbstracts;
  return {
    abstracts: rows.slice(0, cap),
    total,
    hasMore: rows.length > cap,
  };
}
