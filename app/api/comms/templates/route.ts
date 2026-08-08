import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
import { handle, ok } from "@/lib/api/http";
import { assertEventQueryBound, OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import { sanitizeHtml } from "@/lib/sanitize-html";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/comms/templates — admin-only templates for the active event. */
export const GET = handle(async () => {
  const ctx = await requireContext(["ADMIN"]);
  const templates = await prisma.emailTemplate.findMany({
    where: { eventId: ctx.eventId },
    select: { id: true, key: true, subject: true, htmlBody: true, trigger: true, updatedAt: true },
    orderBy: { key: "asc" },
    take: OPERATOR_QUERY_LIMITS.templates + 1,
  });
  assertEventQueryBound(templates, OPERATOR_QUERY_LIMITS.templates, "email templates");

  return ok(templates.map((template) => ({
    ...template,
    // Existing seed/admin HTML is defense-in-depth sanitized before it reaches any client.
    htmlBody: sanitizeHtml(template.htmlBody),
  })));
});
