import { redirect } from "next/navigation";
import "@/components/feature.css";
import { PageHeader } from "@/components/ui";
import { getApiContext } from "@/lib/api/context";
import { assertEventQueryBound, OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import { getResendFrom, useMockIntegrations } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { integrationStatus } from "@/lib/operations/status";
import { DecisionsPanel } from "./decisions-panel";
import { RemindersPanel } from "./reminders-panel";
import { ImportPanel } from "./import-panel";
import { IntegrationsPanel } from "./integrations-panel";
import { TemplatesPanel } from "./templates-panel";
import { sanitizeHtml } from "@/lib/sanitize-html";
import styles from "./operations.module.css";

export const metadata = { title: "Operations" };
export const dynamic = "force-dynamic";

/**
 * `/admin/operations` — the operator surface for integrations that previously
 * existed only as APIs (plan item B5).
 *
 * Every action is a POST the server already authorizes and validates; this page
 * adds no new privileges. Credentials are never sent to the browser — only
 * booleans describing whether an integration is connected, so the console can
 * say up front whether a button will really reach a third party.
 */
export default async function AdminOperationsPage() {
  const ctx = await getApiContext();
  if (!ctx) redirect("/login");
  if (ctx.role !== "ADMIN") redirect("/portal");
  const eventId = ctx.eventId;

  const [event, templates, forms, speakerRows, decidedAbstracts] = await Promise.all([
    prisma.event.findUnique({ where: { id: eventId }, select: { timezone: true } }),
    prisma.emailTemplate.findMany({
      where: { eventId },
      select: { id: true, key: true, subject: true, htmlBody: true, trigger: true, updatedAt: true },
      orderBy: { key: "asc" },
      take: OPERATOR_QUERY_LIMITS.templates,
    }),
    prisma.formConfig.findMany({
      where: { eventId },
      select: { id: true, name: true, slug: true },
      orderBy: { name: "asc" },
      take: OPERATOR_QUERY_LIMITS.importForms,
    }),
    prisma.sessionSpeaker.findMany({
      where: { session: { eventId } },
      select: {
        userId: true,
        user: { select: { name: true, email: true } },
        session: { select: { title: true } },
      },
      orderBy: { user: { email: "asc" } },
      take: OPERATOR_QUERY_LIMITS.reminderSessionSpeakers,
    }),
    // Decided proposals are the only ones a speaker should hear about by email.
    prisma.abstract.findMany({
      where: { eventId, status: { in: ["ACCEPTED", "REJECTED"] } },
      select: {
        id: true,
        title: true,
        status: true,
        submitter: { select: { name: true, email: true } },
        speakers: { select: { user: { select: { email: true } } }, take: 25 },
        // Only scores that carry a written comment can appear in the email, so
        // the panel must not promise feedback that is just a number.
        _count: { select: { reviewScores: { where: { comment: { not: null } } } } },
      },
      orderBy: [{ decidedAt: "desc" }, { title: "asc" }],
      take: OPERATOR_QUERY_LIMITS.decidedAbstracts + 1,
    }),
  ]);

  assertEventQueryBound(
    decidedAbstracts,
    OPERATOR_QUERY_LIMITS.decidedAbstracts,
    "decided proposals available for decision email",
  );

  // One row per speaker; the reminders API is keyed by user, not by session.
  const speakers = [...new Map(speakerRows.map((row) => [row.userId, {
    userId: row.userId,
    name: row.user.name,
    email: row.user.email,
  }])).values()];

  const mocked = useMockIntegrations();
  const airtable = integrationStatus({
    name: "Airtable",
    mocked,
    configured: Boolean(process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID),
    action: "copy the programme to Airtable",
  });
  const accelevents = integrationStatus({
    name: "Accelevents",
    mocked,
    configured: Boolean(process.env.ACCELEVENTS_BASE_URL),
    action: "send the programme to Accelevents",
  });
  const email = integrationStatus({
    name: "Email",
    mocked,
    // Mirror the reminders route exactly: a key without a valid sender address
    // still dispatches in mock mode, so "connected" requires both.
    configured: Boolean(process.env.RESEND_API_KEY) && Boolean(getResendFrom()),
    action: "deliver real email",
  });

  return (
    <section className="page-stack">
      <PageHeader
        eyebrow="Operations"
        title="Operations"
        description="Send speaker reminders, bring proposals in from a spreadsheet, and keep your other tools in step with the programme."
      />

      <div className={styles.grid}>
        <RemindersPanel
          eventId={eventId}
          timezone={event?.timezone ?? "UTC"}
          templates={templates.map((template) => ({ key: template.key, subject: template.subject, trigger: template.trigger }))}
          speakers={speakers}
          email={email}
        />
        <ImportPanel eventId={eventId} forms={forms} />
        <DecisionsPanel
          decided={decidedAbstracts.map((abstract) => ({
            id: abstract.id,
            title: abstract.title,
            status: abstract.status as "ACCEPTED" | "REJECTED",
            speakerName: abstract.submitter.name,
            recipientCount: new Set([
              abstract.submitter.email.toLowerCase(),
              ...abstract.speakers.map((row) => row.user.email.toLowerCase()),
            ]).size,
            feedbackCount: abstract._count.reviewScores,
          }))}
        />
        <IntegrationsPanel eventId={eventId} airtable={airtable} accelevents={accelevents} />
        <TemplatesPanel
          templates={templates.map((template) => ({
            id: template.id,
            key: template.key,
            subject: template.subject,
            trigger: template.trigger,
            // Defense in depth: seeded/admin HTML is sanitized before any client sees it.
            htmlBody: sanitizeHtml(template.htmlBody),
            updatedAt: template.updatedAt.toISOString(),
          }))}
        />
      </div>
    </section>
  );
}
