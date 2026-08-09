import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok } from "@/lib/api/http";
import { serializeForm } from "@/lib/api/form-serialize";
import { lockFormConfigForShapeWrite } from "@/lib/services/form-config-lock";
import { requireEventOwnedRow } from "@/lib/services/event-owned-row";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ formId: string }> };

/** GET /api/cfp/forms/:formId — single form config (admin). */
export function GET(_req: Request, ctx: Params) {
  return handle(async () => {
    const auth = await requireContext(["ADMIN"]);
    const { formId } = await ctx.params;
    const form = await prisma.formConfig.findUnique({
      where: { id: formId },
      include: { fields: true },
    });
    if (!form || form.eventId !== auth.eventId) {
      throw new ApiError(404, "FORM_NOT_FOUND", "Form not found.");
    }
    return ok(serializeForm(form));
  })(_req);
}

/** DELETE /api/cfp/forms/:formId — remove a form with no submissions (admin). */
export function DELETE(_req: Request, ctx: Params) {
  return handle(async () => {
    const auth = await requireContext(["ADMIN"]);
    const { formId } = await ctx.params;
    await prisma.$transaction(async (tx) => {
      // The current stored owner must remain locked through the existing
      // Abstract-use guard and delete. This intentionally preserves only the
      // existing narrow guard; broader form-delete safety remains a later slice.
      const existing = await lockFormConfigForShapeWrite(tx, formId);
      const form = requireEventOwnedRow(existing, auth.eventId, "FORM_NOT_FOUND", "Form");
      const abstractCount = await tx.abstract.count({ where: { formConfigId: form.id } });
      if (abstractCount > 0) {
        throw new ApiError(
          409,
          "FORM_HAS_ABSTRACTS",
          "Unpublish instead: this form already has submissions.",
        );
      }
      await tx.formConfig.delete({ where: { id: form.id } });
    });
    return ok({ id: formId, deleted: true });
  })(_req);
}
