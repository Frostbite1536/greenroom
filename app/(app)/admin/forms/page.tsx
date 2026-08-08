import Link from "next/link";
import { ExternalLink, FileText, Plus, Search } from "lucide-react";
import "@/components/feature.css";
import { PageHeader, Pill } from "@/components/ui";
import { FORMS } from "@/lib/fixtures";

export const metadata = { title: "Submission Forms · Greenroom" };

function formatWindow(form: (typeof FORMS)[number]): string {
  if (!form.closesAt) return "No deadline";
  const closes = new Date(form.closesAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `Closes ${closes}`;
}

export default function FormsPage() {
  const published = FORMS.filter((f) => f.published).length;
  const totalSubs = FORMS.reduce((n, f) => n + f.submissionCount, 0);

  return (
    <section className="page-stack">
      <PageHeader
        eyebrow="Collect & review"
        title="Submission Forms"
        description="Collect abstract, session, and participant information with conditional logic and category-based routing."
        actions={
          <Link className="primary-button" href={`/admin/forms/${FORMS[0].id}`} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            <Plus size={16} aria-hidden="true" /> Create form
          </Link>
        }
      />

      <div className="metric-grid">
        <div className="metric"><span>Forms</span><strong>{FORMS.length}</strong></div>
        <div className="metric"><span>Published</span><strong>{published}</strong></div>
        <div className="metric"><span>Total submissions</span><strong>{totalSubs}</strong></div>
      </div>

      <div className="card">
        <div className="table-toolbar">
          <span className="ghost-button" aria-hidden="true"><Search size={15} /> Search forms…</span>
          <span className="spacer" />
          <span className="hint">Sorted by most pending</span>
        </div>
        <div className="form-list" style={{ padding: 12 }}>
          {FORMS.map((form) => (
            <Link key={form.id} href={`/admin/forms/${form.id}`} className="card form-list-item">
              <span className="form-icon"><FileText size={19} aria-hidden="true" /></span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="row wrap">
                  <h3>{form.name}</h3>
                  <Pill tone={form.published ? "good" : "neutral"}>{form.published ? "Open" : "Draft"}</Pill>
                  {form.slug.includes("sponsor") ? <Pill tone="info">Sessions</Pill> : <Pill tone="info">Abstracts</Pill>}
                </div>
                <p className="form-meta">
                  {form.submissionCount} submissions · {form.draftCount} drafts · {formatWindow(form)}
                </p>
              </div>
              <span className="ghost-button" aria-hidden="true" title="Open public form">
                <ExternalLink size={15} />
              </span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
