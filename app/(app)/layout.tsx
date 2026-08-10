import { AppShell } from "@/components/app-shell";
import { requireSession } from "@/lib/auth";
import { getOpenCfpEntry } from "@/lib/data/open-cfp";

export default async function WorkspaceLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await requireSession();
  // One request-deduplicated read (`cache()`), shared with any page below that
  // renders the same D-C5-3 entry.
  const openCfp = await getOpenCfpEntry(session.event.id);

  return (
    <AppShell session={session} openCfp={openCfp}>
      {children}
    </AppShell>
  );
}
