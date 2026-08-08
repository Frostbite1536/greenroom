import { PagePlaceholder } from "@/components/page-placeholder";

export default function FormsPage() {
  return <PagePlaceholder eyebrow="Call for proposals" title="Forms" description="Configure welcome and confirmation copy, submission windows, speaker limits, and conditional custom fields." metrics={[{ label: "Published", value: "2" }, { label: "Abstracts", value: "128" }, { label: "Closing soon", value: "1" }]} nextSteps={["Build the field configuration surface from locked contracts.", "Preview public forms at every responsive size.", "Connect draft, publish, and submission-limit controls."]} />;
}
