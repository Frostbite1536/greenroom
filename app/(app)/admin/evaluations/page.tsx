import "@/components/feature.css";
import { PageHeader } from "@/components/ui";
import { EvaluationWorkspace } from "@/components/evaluation-workspace";
import { getEvaluationQueue } from "@/lib/data/reads";

export const metadata = { title: "Evaluation" };
export const dynamic = "force-dynamic";

export default async function EvaluationsPage() {
  const view = await getEvaluationQueue();

  return (
    <section className="page-stack" style={{ width: "min(1280px, 100%)" }}>
      <PageHeader
        eyebrow="Collect & review"
        title="Evaluation"
        description="Score abstracts against your rubric. Assignments are routed to review teams by category."
      />
      <div className="metric-grid">
        <div className="metric"><span>Round</span><strong>{view.plan ? `Round ${view.plan.ordinal}` : "—"}</strong></div>
        <div className="metric"><span>Rubric criteria</span><strong>{view.plan?.rubric.length ?? 0}</strong></div>
        <div className="metric">
          <span>Completed reviews</span>
          <strong>{view.plan ? `${view.plan.completedCount}/${view.plan.assignmentCount}` : "—"}</strong>
        </div>
      </div>
      <EvaluationWorkspace view={view} />
    </section>
  );
}
