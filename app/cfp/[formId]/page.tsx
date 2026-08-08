import { notFound } from "next/navigation";
import { PagePlaceholder } from "@/components/page-placeholder";

export default async function PublicCfpPage({ params }: { params: Promise<{ formId: string }> }) {
  const { formId } = await params;
  if (!formId) notFound();

  return <PagePlaceholder eyebrow="Forward 2026 CFP" title="Submit an abstract" description="Share your proposal and speaker details. You can save a draft before the submission window closes." metrics={[{ label: "Form", value: formId }, { label: "Speakers", value: "1–4" }, { label: "Status", value: "Open" }]} nextSteps={["Render configured standard and custom fields.", "Evaluate conditional visibility locally.", "Save drafts and validate speaker limits on submit."]} />;
}
