import { redirect } from "next/navigation";
import "@/components/feature.css";
import { requireSession } from "@/lib/auth";
import { resolveSessionUser } from "@/lib/portal/user";
import { SubmissionEditor } from "./submission-editor";

export const metadata = { title: "Your proposal" };
export const dynamic = "force-dynamic";

/**
 * Speaker edit surface for one submission (R1).
 *
 * Authorization is enforced twice over: this page needs a session that resolves
 * to a provisioned user, and the backend route the editor calls independently
 * requires the caller to be an `AbstractSpeaker` on the abstract. The page
 * deliberately does not read the abstract itself — the CFP form spec and
 * edit rules are backend-owned, so the editor consumes them over the API rather
 * than this route re-deriving them.
 */
export default async function PortalSubmissionPage({
  params,
}: {
  params: Promise<{ abstractId: string }>;
}) {
  const session = await requireSession();
  const user = await resolveSessionUser(session);
  if (!user) redirect("/login");
  const { abstractId } = await params;

  return (
    <section className="page-stack">
      <header className="page-header">
        <div>
          <p className="eyebrow">Speaker workspace</p>
          <h1>Your proposal</h1>
          <p>Update the details the program team and attendees will see.</p>
        </div>
      </header>
      <SubmissionEditor abstractId={abstractId} />
    </section>
  );
}
