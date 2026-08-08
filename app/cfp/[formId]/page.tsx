import { notFound } from "next/navigation";
import "@/components/feature.css";
import { CfpForm, CfpBrand } from "@/components/cfp-form";
import { getPublicForm } from "@/lib/data/reads";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ formId: string }> }) {
  const { formId } = await params;
  const form = await getPublicForm(formId);
  return { title: form ? `${form.name} · ${form.eventName}` : "Submit a proposal" };
}

export default async function PublicCfpPage({
  params,
}: {
  params: Promise<{ formId: string }>;
}) {
  const { formId } = await params;
  const form = await getPublicForm(formId);
  if (!form) notFound();

  const closesAt = form.closesAt ? new Date(form.closesAt) : null;
  const opensAt = form.opensAt ? new Date(form.opensAt) : null;
  const notYetOpen = opensAt !== null && Date.now() < opensAt.getTime();

  return (
    <main className="cfp-page">
      <div className="cfp-shell">
        <CfpBrand eventName={form.eventName} />
        {form.isOpen ? (
          <CfpForm form={form} />
        ) : (
          <div className="cfp-card">
            <h2 style={{ marginTop: 0 }}>
              {notYetOpen ? "Submissions have not opened yet" : "Submissions are closed"}
            </h2>
            <p className="muted">
              {notYetOpen && opensAt
                ? `This call for speakers opens ${opensAt.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}.`
                : closesAt
                  ? `The submission window closed on ${closesAt.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}.`
                  : "This call for speakers is not currently accepting submissions."}
            </p>
            <p className="hint">If you already submitted, the program team will follow up by email.</p>
          </div>
        )}
        <p className="hint" style={{ textAlign: "center" }}>{form.eventName} · call for speakers</p>
      </div>
    </main>
  );
}
