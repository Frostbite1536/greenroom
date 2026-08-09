import "@/components/feature.css";
import { PageHeader } from "@/components/ui";
import { EvaluationWorkspace } from "@/components/evaluation-workspace";
import { EvaluationSetup, SetupSummary } from "@/components/evaluation-setup";
import { getEvaluationQueue, getEvaluationSetup } from "@/lib/data/reads";

export const metadata = { title: "Evaluation" };
export const dynamic = "force-dynamic";

export default async function EvaluationsPage() {
  const view = await getEvaluationQueue();

  // Admins run the review process; evaluators score. Showing an admin the
  // (usually empty) scoring queue and nothing else was the single biggest gap
  // in this screen — the setup they actually need had no UI at all.
  if (view.role === "ADMIN") {
    const setup = await getEvaluationSetup();
    const plan = setup.plans[setup.plans.length - 1] ?? null;

    return (
      <section className="page-stack" style={{ width: "min(1280px, 100%)" }}>
        <PageHeader
          eyebrow="Collect & review"
          title="Evaluation"
          description="Set up review rounds, assign proposals to your review team, and track how far the reviewing has got."
        />
        <SetupSummary view={setup} plan={plan} />
        <EvaluationSetup view={setup} />
        {view.queue.length > 0 ? (
          <>
            <PageHeader
              eyebrow="Your own reviews"
              title="Assigned to you"
              description="Proposals you have been asked to score in the current round."
            />
            <EvaluationWorkspace view={view} />
          </>
        ) : null}
      </section>
    );
  }

  const reviewableQueue = view.queue.filter((row) => row.abstractStatus !== "WITHDRAWN");

  return (
    <section className="page-stack" style={{ width: "min(1280px, 100%)" }}>
      <PageHeader
        eyebrow="Collect & review"
        title="Evaluation"
        description="Score proposals against the rubric for this round."
      />
      <div className="metric-grid">
        <div className="metric"><span>Round</span><strong>{view.plan ? `Round ${view.plan.ordinal}` : "—"}</strong></div>
        <div className="metric"><span>Rubric criteria</span><strong>{view.plan?.rubric.length ?? 0}</strong></div>
        <div className="metric">
          <span>Your progress</span>
          <strong>
            {reviewableQueue.length === 0
              ? view.queue.length === 0 ? "—" : "Complete"
              : `${reviewableQueue.filter((q) => q.status === "COMPLETED").length}/${reviewableQueue.length}`}
          </strong>
        </div>
      </div>
      <EvaluationWorkspace view={view} />
    </section>
  );
}
