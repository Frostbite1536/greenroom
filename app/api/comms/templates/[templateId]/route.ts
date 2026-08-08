import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { sanitizeHtml } from "@/lib/sanitize-html";
import {
  emailTemplateUpdateSchema,
  sanitizeTemplateBody,
  unknownTemplateVariables,
} from "@/lib/comms/template-edit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ templateId: string }> };

/**
 * PATCH /api/comms/templates/:templateId — edit the wording of one reminder.
 *
 * ADMIN-only and event-scoped (INV-EVENT-001): a template belonging to another
 * event is a 404, not a 403, so this cannot be used to probe for ids.
 *
 * `key` is intentionally NOT editable. Reminders address a template by
 * `(eventId, key)`, so renaming one would silently break every trigger that
 * points at it — an operator changing wording must not be able to detach the
 * template from the thing that sends it.
 *
 * The body is sanitized before it is stored (INV-HTML-001 at rest, not just on
 * read) and the response reports whether anything was removed, so the operator
 * is told rather than quietly losing markup.
 */
export function PATCH(req: Request, ctx: Params) {
  return handle(async () => {
    const auth = await requireContext(["ADMIN"]);
    const { templateId } = await ctx.params;
    const input = await parseBody(req, emailTemplateUpdateSchema);

    const existing = await prisma.emailTemplate.findUnique({
      where: { id: templateId },
      select: { id: true, eventId: true },
    });
    if (!existing || existing.eventId !== auth.eventId) {
      throw new ApiError(404, "TEMPLATE_NOT_FOUND", "That template does not exist for this event.");
    }

    const { htmlBody, changed } = sanitizeTemplateBody(input.htmlBody);
    if (htmlBody.trim().length === 0) {
      throw new ApiError(422, "EMPTY_TEMPLATE_BODY", "That message is empty once unsupported formatting is removed.");
    }

    const template = await prisma.emailTemplate.update({
      where: { id: existing.id },
      data: {
        subject: input.subject,
        htmlBody,
        trigger: input.trigger?.trim() ? input.trigger.trim() : null,
      },
      select: { id: true, key: true, subject: true, htmlBody: true, trigger: true, updatedAt: true },
    });

    return ok({
      template: { ...template, htmlBody: sanitizeHtml(template.htmlBody) },
      // Advisory, not errors: the operator may have meant a caller-supplied variable.
      sanitized: changed,
      unknownVariables: unknownTemplateVariables(template.subject, template.htmlBody),
    });
  })(req);
}
