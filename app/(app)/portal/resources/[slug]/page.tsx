import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sanitizeHtml } from "@/lib/sanitize-html";
import styles from "../../portal.module.css";

export const dynamic = "force-dynamic";

export default async function ResourcePage({ params }: { params: Promise<{ slug: string }> }) {
  const session = await requireSession();
  const { slug } = await params;

  const resource = await prisma.resourceWiki.findFirst({
    where: { eventId: session.event.id, slug, published: true },
    select: { title: true, summary: true, htmlContent: true, updatedAt: true },
  });

  if (!resource) notFound();

  // INV-HTML-001: sanitize before rendering, regardless of what was stored.
  const safeHtml = sanitizeHtml(resource.htmlContent);

  return (
    <section className="page-stack">
      <header className="page-header">
        <div>
          <p className="eyebrow">
            <Link href="/portal">← Back to portal</Link>
          </p>
          <h1>{resource.title}</h1>
          {resource.summary ? <p>{resource.summary}</p> : null}
        </div>
      </header>

      <section className={styles.card}>
        <div dangerouslySetInnerHTML={{ __html: safeHtml }} />
        <p className={styles.taskMeta}>
          Last updated{" "}
          {resource.updatedAt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}
        </p>
      </section>
    </section>
  );
}
