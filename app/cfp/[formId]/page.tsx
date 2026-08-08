import { notFound } from "next/navigation";
import "@/components/feature.css";
import { CfpForm, CfpBrand } from "@/components/cfp-form";
import { EVENT_META, getForm } from "@/lib/fixtures";

export const metadata = { title: "Submit a proposal · Greenroom" };

export default async function PublicCfpPage({
  params,
}: {
  params: Promise<{ formId: string }>;
}) {
  const { formId } = await params;
  const form = getForm(formId);
  if (!form) notFound();

  const now = Date.now();
  const closed =
    !form.published ||
    (form.opensAt && now < new Date(form.opensAt).getTime()) ||
    (form.closesAt && now > new Date(form.closesAt).getTime());

  return (
    <main className="cfp-page">
      <div className="cfp-shell">
        <CfpBrand eventName={EVENT_META.name} />
        {closed ? (
          <div className="cfp-card">
            <h2 style={{ marginTop: 0 }}>Submissions are closed</h2>
            <p className="muted">
              This call for speakers is not currently accepting submissions
              {form.closesAt ? ` (closed ${new Date(form.closesAt).toLocaleDateString()})` : ""}. Please check back later.
            </p>
          </div>
        ) : (
          <CfpForm form={form} />
        )}
        <p className="hint" style={{ textAlign: "center" }}>Powered by Greenroom · {EVENT_META.name}</p>
      </div>
    </main>
  );
}
