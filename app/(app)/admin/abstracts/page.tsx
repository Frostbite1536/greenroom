import "@/components/feature.css";
import { PageHeader } from "@/components/ui";
import { AbstractsTable } from "@/components/abstracts-table";
import { getAdminAbstracts } from "@/lib/data/reads";

export const metadata = { title: "Abstracts" };
export const dynamic = "force-dynamic";

export default async function AbstractsPage() {
  const { abstracts } = await getAdminAbstracts();

  const accepted = abstracts.filter((a) => a.status === "ACCEPTED").length;
  const pending = abstracts.filter((a) => a.status === "SUBMITTED" || a.status === "UNDER_REVIEW").length;

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
      <AbstractsTable abstracts={abstracts} />
    </section>
  );
}
