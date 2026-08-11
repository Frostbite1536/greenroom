import { redirect } from "next/navigation";
import "@/components/feature.css";
import { PageHeader } from "@/components/ui";
import { ResourceManager } from "@/components/resource-manager";
import { getApiContext } from "@/lib/api/context";
import { OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import { prisma } from "@/lib/prisma";
import { ADMIN_RESOURCE_ORDER, serializeResource } from "@/lib/services/resource-wiki";

export const metadata = { title: "Resources & wiki" };
export const dynamic = "force-dynamic";

/**
 * Resource / wiki authoring (buyer requirement 8).
 *
 * Server-rendered like every other admin page: page-level auth redirects rather
 * than throwing, the read is bounded cap-plus-one the way the operator API
 * routes bound theirs, and every mutation goes back through
 * `/api/admin/resources` where authorization is actually enforced.
 */
export default async function AdminResourcesPage() {
  const ctx = await getApiContext();
  if (!ctx) redirect("/login");
  if (ctx.role !== "ADMIN") redirect("/portal");

  const rows = await prisma.resourceWiki.findMany({
    where: { eventId: ctx.eventId },
    orderBy: ADMIN_RESOURCE_ORDER,
    take: OPERATOR_QUERY_LIMITS.adminResources + 1,
    select: {
      id: true,
      slug: true,
      title: true,
      summary: true,
      htmlContent: true,
      published: true,
      updatedAt: true,
    },
  });

  // Read one extra row and say so, rather than silently authoring against a
  // partial list — the same discipline the speaker page takes.
  const truncated = rows.length > OPERATOR_QUERY_LIMITS.adminResources;
  const resources = rows.slice(0, OPERATOR_QUERY_LIMITS.adminResources).map(serializeResource);
  const published = resources.filter((resource) => resource.published).length;

  return (
    <section className="page-stack">
      <PageHeader
        eyebrow="Speaker portal content"
        title="Resources & wiki"
        description="Pages speakers read in their portal — the handbook, venue and travel notes, anything else they need. HTML is supported and sanitized on save."
      />

      <div className="metric-grid">
        <div className="metric"><span>Pages</span><strong>{resources.length}</strong></div>
        <div className="metric"><span>Published</span><strong>{published}</strong></div>
        <div className="metric"><span>Drafts</span><strong>{resources.length - published}</strong></div>
      </div>

      {truncated ? (
        <p className="hint" role="status">
          This event has more resource pages than this page loads at once. The list below is incomplete — reduce
          the event data before editing it.
        </p>
      ) : null}

      <ResourceManager eventId={ctx.eventId} resources={resources} />
    </section>
  );
}
