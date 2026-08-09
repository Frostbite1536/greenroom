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
  const [{ abstracts }, params] = await Promise.all([getAdminAbstracts(), searchParams]);
  // A selected proposal is a useful review deep link and lets the server render
  // the accessible drawer from the first response. Never trust the URL alone:
  // it must name an abstract already scoped by getAdminAbstracts().
  const requestedId = typeof params.abstractId === "string" ? params.abstractId : null;
  const initialSelectedId = requestedId && abstracts.some((abstract) => abstract.id === requestedId)
    ? requestedId
    : null;
  const initialChanging = initialSelectedId !== null && params.mode === "decide";

  const accepted = abstracts.filter((a) => a.status === "ACCEPTED").length;
  // A Maybe is deliberately still under consideration, so it belongs in the
  // producer's pending-review count until the team accepts or declines it.
  const pending = abstracts.filter((a) => {
    const status = String(a.status);
    return status === "SUBMITTED" || status === "UNDER_REVIEW" || status === "MAYBE";
  }).length;

  return (
    <section className="page-stack">
      <PageHeader
        eyebrow="Submissions"
        title="Abstracts"
        description="Review and manage abstract submissions through the acceptance pipeline."
      />
      <div className="metric-grid">
        <div className="metric"><span>Total</span><strong>{abstracts.length}</strong></div>
        <div className="metric"><span>Pending review</span><strong>{pending}</strong></div>
        <div className="metric"><span>Accepted</span><strong>{accepted}</strong></div>
      </div>
      <AbstractsTable
        abstracts={abstracts}
        initialSelectedId={initialSelectedId}
        initialChanging={initialChanging}
      />
    </section>
  );
}
