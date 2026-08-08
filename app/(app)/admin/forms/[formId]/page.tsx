import { notFound } from "next/navigation";
import "@/components/feature.css";
import { FormBuilder } from "@/components/form-builder";
import { getForm } from "@/lib/fixtures";

export const metadata = { title: "Edit form · Sessionboard" };

export default async function FormBuilderPage({
  params,
}: {
  params: Promise<{ formId: string }>;
}) {
  const { formId } = await params;
  const form = getForm(formId);
  if (!form) notFound();
  return <FormBuilder form={form} />;
}
