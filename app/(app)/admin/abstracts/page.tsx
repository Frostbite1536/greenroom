import "@/components/feature.css";
import { PageHeader } from "@/components/ui";
import { AbstractsTable } from "@/components/abstracts-table";
import { ABSTRACTS } from "@/lib/fixtures";

export const metadata = { title: "Abstracts · Greenroom" };

export default function AbstractsPage() {
  const accepted = ABSTRACTS.filter((a) => a.status === "ACCEPTED").length;
  const pending = ABSTRACTS.filter((a) => a.status === "SUBMITTED" || a.status === "UNDER_REVIEW").length;

  return (
    <section className="page-stack">
      <PageHeader
        eyebrow="Submissions"
        title="Abstracts"
        description="Review and manage abstract submissions through the acceptance pipeline."
      />
      <div className="metric-grid">
        <div className="metric"><span>Total</span><strong>{ABSTRACTS.length}</strong></div>
        <div className="metric"><span>Pending review</span><strong>{pending}</strong></div>
        <div className="metric"><span>Accepted</span><strong>{accepted}</strong></div>
      </div>
      <AbstractsTable />
    </section>
  );
}
