import { notFound } from "next/navigation";
import "@/components/feature.css";
import { FormBuilder } from "@/components/form-builder";
import { getFormForBuilder } from "@/lib/data/reads";

export const metadata = { title: "Edit form" };
export const dynamic = "force-dynamic";

export default async function FormBuilderPage({
  params,
}: {
  params: Promise<{ formId: string }>;
}) {
  const { formId } = await params;
  const result = await getFormForBuilder(formId);
  if (!result) notFound();
  return (
    <FormBuilder
      form={result.form}
      eventId={result.eventId}
      timezone={result.timezone}
      publicFormPath={result.publicFormPath}
      categories={result.categories}
    />
  );
}
