import { PagePlaceholder } from "@/components/page-placeholder";

export default function EvaluationsPage() {
  return <PagePlaceholder eyebrow="Committee workflow" title="Evaluation plans" description="Create review plans, assign abstracts to evaluator teams, and score every proposal against a consistent rubric." metrics={[{ label: "Assigned", value: "94" }, { label: "Completed", value: "61%" }, { label: "Needs review", value: "37" }]} nextSteps={["Create plan and rubric management.", "Add team and evaluator assignments.", "Build a fast, keyboard-friendly scoring queue."]} />;
}
