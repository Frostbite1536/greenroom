import "@/components/feature.css";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { EvaluationWorkspace } from "@/components/evaluation-workspace";
import { EvaluationSetup, SetupSummary } from "@/components/evaluation-setup";
import { getEvaluationQueue, getEvaluationSetup } from "@/lib/data/reads";
import { ApiError } from "@/lib/api/http";

export const metadata = { title: "Evaluation" };
export const dynamic = "force-dynamic";

export default async function EvaluationsPage({
  searchParams,
}: {
  searchParams: Promise<{ planId?: string | string[] }>;
}) {
  // The selected round lives in the URL so a reviewer can link to, reload, and
  // use the back button on a round other than the newest one.
  const params = await searchParams;
  const requestedPlanId = typeof params.planId === "string" ? params.planId : null;
  const view = await (async () => {
    try {
      return await getEvaluationQueue(requestedPlanId);
    } catch (error) {
      // The read scopes an explicit round to this event; an id from another
      // event is indistinguishable from a made-up one, so both 404 here.
      if (error instanceof ApiError && error.code === "PLAN_NOT_FOUND") notFound();
      throw error;
    }
  })();

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
        {/* Gate on assignments across every round, not just the selected one:
            gating on this round's queue would hide the switcher that reaches
            the others. */}
        {view.rounds.some((round) => round.assignedToMe > 0) ? (
          <>
            <PageHeader
              eyebrow="Your own reviews"
              title="Assigned to you"
              description="Proposals you have been asked to score, in any review round of this event."
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
        description="Score proposals against the rubric for the selected round."
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
