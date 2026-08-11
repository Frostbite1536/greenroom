import "@/components/feature.css";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { AbstractsTable } from "@/components/abstracts-table";
import { getAdminAbstracts } from "@/lib/data/reads";
import { readAbstractPermalinkId } from "@/lib/abstract-permalink";
import { getApiContext } from "@/lib/api/context";
import { ApiError } from "@/lib/api/http";

export const metadata = { title: "Abstracts" };
export const dynamic = "force-dynamic";

export default async function AbstractsPage({
  searchParams,
}: {
  searchParams: Promise<{
    /** Canonical shareable permalink; see `@/lib/abstract-permalink`. */
    abstract?: string | string[];
    /** The original parameter, still accepted so existing links keep working. */
    abstractId?: string | string[];
    mode?: string | string[];
    planId?: string | string[];
  }>;
}) {
  // Resolve the persisted role before starting the proposal read. An evaluator
  // belongs only in the assignment-scoped workspace; redirecting here means
  // the global pipeline never serializes a proposal row into their response.
  const paramsPromise = searchParams;
  const ctx = await getApiContext();
  if (!ctx) redirect("/login");
  if (ctx.role === "EVALUATOR") redirect("/admin/evaluations");
  if (ctx.role !== "ADMIN") redirect("/login");

  const params = await paramsPromise;
  // A selected proposal is a useful review deep link and lets the server render
  // the accessible drawer from the first response. Never trust the URL alone:
  // it must name an abstract already scoped by getAdminAbstracts(). Older
  // proposals are intentionally outside the newest bounded table page, but a
  // valid event-scoped deep link still gets its own drawer record.
  // `?abstract=<id>` is the canonical permalink and `?abstractId=` the legacy
  // alias; both are read here rather than at each call site. Resolution stays
  // server-side, so the drawer is present in the FIRST response — a
  // deep-linked proposal is readable without JavaScript having run, and the
  // link survives a paste and a reload.
  const requestedId = readAbstractPermalinkId(params);
  const requestedPlanId = typeof params.planId === "string" ? params.planId : null;
  const view = await (async () => {
    try {
      return await getAdminAbstracts(requestedId, requestedPlanId);
    } catch (error) {
      // The summary service scopes explicit plan ids to this event. Turn its
      // indistinguishable invalid/cross-event result into a route-level 404.
      if (error instanceof ApiError && error.code === "PLAN_NOT_FOUND") notFound();
      throw error;
    }
  })();
  const { abstracts, selectedAbstract, total, hasMore, metrics, decisionSummary } = view;
  const initialSelectedId = requestedId && (selectedAbstract?.id === requestedId || abstracts.some((abstract) => abstract.id === requestedId))
    ? requestedId
    : null;
  const initialChanging = initialSelectedId !== null && params.mode === "decide";

  return (
    <section className="page-stack">
      <PageHeader
        eyebrow="Submissions"
        title="Abstracts"
        description="Review and manage abstract submissions through the acceptance pipeline."
      />
      <div className="metric-grid">
        <div className="metric"><span>Total</span><strong>{metrics.total}</strong></div>
        <div className="metric"><span>Pending review</span><strong>{metrics.pending}</strong></div>
        <div className="metric"><span>Accepted</span><strong>{metrics.accepted}</strong></div>
      </div>
      <AbstractsTable
        abstracts={abstracts}
        initialSelectedAbstract={selectedAbstract}
        initialSelectedId={initialSelectedId}
        initialChanging={initialChanging}
        total={total}
        hasMore={hasMore}
        decisionSummary={decisionSummary}
      />
    </section>
  );
}
