import { AppShell } from "@/components/app-shell";
import { requireSession } from "@/lib/auth";
import { getOpenCfpEntry } from "@/lib/data/open-cfp";
import { getUserWorkspaces } from "@/lib/data/event-memberships";

export default async function WorkspaceLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await requireSession();
  // Both are request-deduplicated reads (`cache()`), issued together rather
  // than in sequence: the CFP entry is shared with any page below that renders
  // it, and the workspace list is the caller's own memberships (D-C5-16). The
  // user id comes from `requireSession()`, which resolved it server-side, so
  // this can only ever list the signed-in person's own events.
  const [openCfp, workspaces] = await Promise.all([
    getOpenCfpEntry(session.event.id),
    getUserWorkspaces(session.user.id),
  ]);

  return (
    <AppShell openCfp={openCfp} session={session} workspaces={workspaces}>
      {children}
    </AppShell>
  );
}
