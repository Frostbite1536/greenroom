import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
import { handle, ok } from "@/lib/api/http";
import { assertEventQueryBound, OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import { sanitizeHtml } from "@/lib/sanitize-html";
import { fixedTemplatePreview, templateDelivery } from "@/lib/comms/template-truth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/comms/templates — admin-only templates for the active event.
 *
 * Each row carries its delivery truth (C21/audit4#30): `editable` says whether
 * changing this wording actually changes what a recipient receives, and a
 * read-only row ships `sentMessage` — the real fixed message, produced by the
 * same builder the send path calls, so a client can show what will really go
 * out instead of the stored text nothing renders.
 */
export const GET = handle(async () => {
  const ctx = await requireContext(["ADMIN"]);
  const templates = await prisma.emailTemplate.findMany({
    where: { eventId: ctx.eventId },
    select: { id: true, key: true, subject: true, htmlBody: true, trigger: true, updatedAt: true },
    orderBy: { key: "asc" },
    take: OPERATOR_QUERY_LIMITS.templates + 1,
  });
  assertEventQueryBound(templates, OPERATOR_QUERY_LIMITS.templates, "email templates");

  return ok(templates.map((template) => {
    const delivery = templateDelivery(template.key);
    const sentMessage = fixedTemplatePreview(template.key);
    return {
      ...template,
      // Existing seed/admin HTML is defense-in-depth sanitized before it reaches any client.
      htmlBody: sanitizeHtml(template.htmlBody),
      editable: delivery.editable,
      deliveryMode: delivery.mode,
      deliverySummary: delivery.summary,
      deliveryReason: delivery.reason ?? null,
      // Null for editable templates: their stored body already is the message.
      sentMessage,
    };
  }));
});
