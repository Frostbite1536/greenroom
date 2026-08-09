import "@/components/feature.css";
import { CfpBrand } from "@/components/cfp-form";
import { ReviewerInviteAccept } from "@/components/reviewer-invite-accept";

export const metadata = { title: "Reviewer invitation" };

/** The bearer remains client-only in the URL fragment and is never rendered by this page. */
export default function ReviewerInvitePage() {
  return (
    <main className="cfp-page">
      <div className="cfp-shell">
        <CfpBrand eventName="Greenroom" />
        <section className="cfp-card" aria-labelledby="reviewer-invite-heading">
          <h1 id="reviewer-invite-heading" style={{ marginTop: 0 }}>Reviewer invitation</h1>
          <ReviewerInviteAccept />
        </section>
      </div>
    </main>
  );
}
