import Link from "next/link";
import { ExternalLink, FileText } from "lucide-react";
import "@/components/feature.css";
import { EmptyState, PageHeader, Pill } from "@/components/ui";
import { NewFormDialog } from "@/components/new-form-dialog";
import { getFormsList } from "@/lib/data/reads";

export const metadata = { title: "Submission Forms" };
export const dynamic = "force-dynamic";

function windowLabel(form: { closesAt: string | null; isOpen: boolean; published: boolean }): string {
  if (!form.published) return "Not published";
  if (!form.closesAt) return "No deadline";
  const closes = new Date(form.closesAt);
  const verb = closes.getTime() < Date.now() ? "Closed" : "Closes";
  return `${verb} ${closes.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

export default async function FormsPage() {
  const { eventId, eventSlug, forms } = await getFormsList();
  const published = forms.filter((f) => f.published).length;
  const totalSubs = forms.reduce((n, f) => n + f.submissionCount, 0);

  return (
    <section className="page-stack">
      <PageHeader
        eyebrow="Collect & review"
        title="Submission Forms"
        description="Collect abstract, session, and participant information with conditional logic and category-based routing."
        actions={<NewFormDialog eventId={eventId} eventSlug={eventSlug} existingSlugs={forms.map((f) => f.slug)} />}
      />

      <div className="metric-grid">
        <div className="metric"><span>Forms</span><strong>{forms.length}</strong></div>
        <div className="metric"><span>Published</span><strong>{published}</strong></div>
        <div className="metric"><span>Total submissions</span><strong>{totalSubs}</strong></div>
      </div>

      <div className="card">
        {forms.length === 0 ? (
          <EmptyState icon={<FileText size={22} />} title="No forms yet">
            Use <strong>New form</strong> above to start collecting proposals.
          </EmptyState>
        ) : (
          <div className="form-list" style={{ padding: 12 }}>
            {forms.map((form) => (
              <Link key={form.id} href={`/admin/forms/${form.id}`} className="card form-list-item">
                <span className="form-icon"><FileText size={19} aria-hidden="true" /></span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="row wrap">
                    <h3>{form.name}</h3>
                    <Pill tone={form.isOpen ? "good" : form.published ? "warn" : "neutral"}>
                      {form.isOpen ? "Open" : form.published ? "Closed" : "Draft"}
                    </Pill>
                  </div>
                  <p className="form-meta">
                    {form.submissionCount} submissions · {form.draftCount} drafts · {windowLabel(form)}
                  </p>
                </div>
                <span className="ghost-button" aria-hidden="true" title="Open public form">
                  <ExternalLink size={15} />
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
