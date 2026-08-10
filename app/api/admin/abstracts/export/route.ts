import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
import { handle } from "@/lib/api/http";
import {
  ADMIN_ABSTRACT_LIST_TAKE,
  adminAbstractListOrderBy,
  adminAbstractListWhere,
  toAdminAbstractListEnvelope,
} from "@/lib/api/admin-abstract-list";
import { getAdminDecisionSummary } from "@/lib/services/admin-decision-summary";
import {
  buildDecisionExportCsv,
  decisionExportFilename,
  type DecisionExportRow,
} from "@/lib/services/decision-export-csv";

export const dynamic = "force-dynamic";

/**
 * The export reads exactly what the abstracts table reads: no email, no
 * evaluator link, no answer bodies. Widening this select is how a blind review
 * leaks — the aggregate columns come from the decision-summary service, which
 * projects counts and one weighted average and nothing that identifies a
 * reviewer.
 */
const exportSelect = {
  id: true,
  title: true,
  status: true,
  submittedAt: true,
  decidedAt: true,
  category: { select: { name: true } },
  speakers: { select: { isPrimary: true, user: { select: { name: true } } } },
} satisfies Prisma.AbstractSelect;

/**
 * GET /api/admin/abstracts/export — ADMIN-only `text/csv` of the review results
 * shown on `/admin/abstracts` (ABS-13). Accepts the same `?planId=` selection
 * as the list API so an operator exports the round they are looking at.
 *
 * Bounded on purpose (S20): it carries the same newest-first page the admin
 * table does, capped at `OPERATOR_QUERY_LIMITS.adminAbstracts`, and states its
 * own truncation in a final comment row instead of quietly returning a short
 * file. It never streams an unbounded event-wide scan.
 *
 * Aggregation is not re-implemented here. `getAdminDecisionSummary` is the sole
 * authority for which completed reviews count and how they are weighted, and it
 * also enforces the ADMIN role a second time, independently of the check below.
 */
export const GET = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const planId = new URL(req.url).searchParams.get("planId") ?? undefined;

  const where = adminAbstractListWhere({ eventId: ctx.eventId });
  // One RepeatableRead snapshot for the page and its total, so the truncation
  // notice can never describe a different event state than the rows above it.
  const [abstracts, total] = await prisma.$transaction(
    [
      prisma.abstract.findMany({
        where,
        take: ADMIN_ABSTRACT_LIST_TAKE,
        orderBy: adminAbstractListOrderBy,
        select: exportSelect,
      }),
      prisma.abstract.count({ where }),
    ],
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  const page = toAdminAbstractListEnvelope(abstracts, total);

  const rows: DecisionExportRow[] = page.abstracts.map((abstract) => ({
    id: abstract.id,
    title: abstract.title,
    status: abstract.status,
    categoryName: abstract.category?.name ?? null,
    // Primary speaker first, then a stable name order, so re-exporting an
    // unchanged event produces a byte-identical file.
    speakerNames: [...abstract.speakers]
      .sort((left, right) =>
        left.isPrimary === right.isPrimary
          ? left.user.name.localeCompare(right.user.name)
          : Number(right.isPrimary) - Number(left.isPrimary),
      )
      .map((speaker) => speaker.user.name),
    submittedAt: abstract.submittedAt?.toISOString() ?? null,
    decidedAt: abstract.decidedAt?.toISOString() ?? null,
  }));

  const summary = await getAdminDecisionSummary(ctx, {
    abstractIds: rows.map((row) => row.id),
    planId,
  });

  const csv = buildDecisionExportCsv({
    rows,
    summariesByAbstractId: summary.summariesByAbstractId,
    selectedPlan: summary.selectedPlan,
    total: page.total,
    hasMore: page.hasMore,
  });

  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${decisionExportFilename()}"`,
      // A decision export is live operator data, not a cacheable document.
      "cache-control": "no-store",
    },
  });
});
