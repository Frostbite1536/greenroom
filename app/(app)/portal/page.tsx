import { PagePlaceholder } from "@/components/page-placeholder";

export default function PortalPage() {
  return <PagePlaceholder eyebrow="Speaker workspace" title="Your event onboarding" description="Keep profile information, presentation assets, required tasks, and event resources in one place." metrics={[{ label: "Profile", value: "80%" }, { label: "Tasks complete", value: "3 / 5" }, { label: "Sessions", value: "2" }]} nextSteps={["Complete speaker profile and secure uploads.", "Show live task completion status.", "Render sanitized resource wiki content."]} />;
}
