import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { sanitizeHtml } from "@/lib/sanitize-html";
import { requireEventOwnedRow } from "@/lib/services/event-owned-row";
import {
  emailTemplateUpdateSchema,
  missingRequiredTemplateVariables,
  sanitizeTemplateBody,
  templateTriggerPatch,
  unknownTemplateVariables,
} from "@/lib/comms/template-edit";
import { isEditableTemplateKey, readOnlyTemplateRefusal } from "@/lib/comms/template-truth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ templateId: string }> };

/**
 * PATCH /api/comms/templates/:templateId — edit the wording of one reminder.
 *
 * ADMIN-only and event-scoped (INV-EVENT-001): a template belonging to another
 * event is a 404, not a 403, so this cannot be used to probe for ids.
 *
 * Templates whose delivered message is built in code (`lib/comms/template-truth.ts`)
 * are refused outright with `TEMPLATE_READ_ONLY`. Accepting wording that no send
 * path renders is the audit4#30 defect this route must not reintroduce.
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

    const { htmlBody, changed } = sanitizeTemplateBody(input.htmlBody);
    if (htmlBody.trim().length === 0) {
      throw new ApiError(422, "EMPTY_TEMPLATE_BODY", "That message is empty once unsupported formatting is removed.");
    }

    const template = await prisma.$transaction(async (tx) => {
      // Lock and authorize the stored row immediately before writing so an id
      // from another event is indistinguishable from an unknown id.
      const [existing] = await tx.$queryRaw<{ id: string; eventId: string; key: string }[]>`
        SELECT "id", "eventId", "key" FROM "EmailTemplate" WHERE "id" = ${templateId} FOR UPDATE
      `;
      const owned = requireEventOwnedRow(existing, auth.eventId, "TEMPLATE_NOT_FOUND", "Template");
      // C21: a template whose message is built in code must not accept edits.
      // Storing wording that nothing renders is what made the console lie, so
      // the refusal lives here — on the write — not only in the UI.
      if (!isEditableTemplateKey(owned.key)) {
        throw new ApiError(409, "TEMPLATE_READ_ONLY", readOnlyTemplateRefusal(owned.key));
      }
      const missing = missingRequiredTemplateVariables(owned.key, input.subject, htmlBody);
      if (missing.length > 0) {
        throw new ApiError(
          422,
          "MISSING_REQUIRED_TEMPLATE_VARIABLE",
          `This template must include ${missing.map((variable) => `{{${variable}}}`).join(", ")}.`,
        );
      }
      return tx.emailTemplate.update({
        where: { id: owned.id },
        data: {
          subject: input.subject,
          htmlBody,
          ...templateTriggerPatch(input.trigger),
        },
        select: { id: true, key: true, subject: true, htmlBody: true, trigger: true, updatedAt: true },
      });
    });

    return ok({
      template: { ...template, htmlBody: sanitizeHtml(template.htmlBody) },
      // Advisory, not errors: the operator may have meant a caller-supplied variable.
      sanitized: changed,
      unknownVariables: unknownTemplateVariables(template.subject, template.htmlBody),
    });
  })(req);
}
