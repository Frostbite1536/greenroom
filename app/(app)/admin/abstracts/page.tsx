import "@/components/feature.css";
import { PageHeader } from "@/components/ui";
import { AbstractsTable } from "@/components/abstracts-table";
import { getAdminAbstracts } from "@/lib/data/reads";

export const metadata = { title: "Abstracts" };
export const dynamic = "force-dynamic";

export default async function AbstractsPage({
  searchParams,
}: {
  searchParams: Promise<{ abstractId?: string | string[]; mode?: string | string[] }>;
}) {
  const params = await searchParams;
  // A selected proposal is a useful review deep link and lets the server render
  // the accessible drawer from the first response. Never trust the URL alone:
  // it must name an abstract already scoped by getAdminAbstracts(). Older
  // proposals are intentionally outside the newest bounded table page, but a
  // valid event-scoped deep link still gets its own drawer record.
  const requestedId = typeof params.abstractId === "string" ? params.abstractId : null;
  const { abstracts, selectedAbstract, total, hasMore, metrics } = await getAdminAbstracts(requestedId);
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
      />
    </section>
  );
}
