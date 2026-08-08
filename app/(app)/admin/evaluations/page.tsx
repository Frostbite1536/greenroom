import "@/components/feature.css";
import { PageHeader } from "@/components/ui";
import { EvaluationWorkspace } from "@/components/evaluation-workspace";
import { EVALUATION_PLAN } from "@/lib/fixtures";

export const metadata = { title: "Evaluation · Greenroom" };

export default function EvaluationsPage() {
  const plan = EVALUATION_PLAN;
  return (
    <section className="page-stack" style={{ width: "min(1280px, 100%)" }}>
      <PageHeader
        eyebrow="Collect & review"
        title="Evaluation"
        description="Score abstracts against your rubric. Assignments are routed to review teams by category."
      />
      <div className="metric-grid">
        <div className="metric"><span>Round</span><strong>{plan.name.split(" — ")[0]}</strong></div>
        <div className="metric"><span>Rubric criteria</span><strong>{plan.rubric.length}</strong></div>
        <div className="metric"><span>Completed</span><strong>{plan.completedCount}/{plan.assignedCount}</strong></div>
      </div>
      <EvaluationWorkspace />
    </section>
  );
}
