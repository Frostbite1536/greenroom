import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok } from "@/lib/api/http";
import { serializeForm } from "@/lib/api/form-serialize";

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
    const form = await prisma.formConfig.findUnique({
      where: { id: formId },
      include: { _count: { select: { abstracts: true } } },
    });
    if (!form || form.eventId !== auth.eventId) {
      throw new ApiError(404, "FORM_NOT_FOUND", "Form not found.");
    }
    if (form._count.abstracts > 0) {
      throw new ApiError(
        409,
        "FORM_HAS_ABSTRACTS",
        "Unpublish instead: this form already has submissions.",
      );
    }
    await prisma.formConfig.delete({ where: { id: formId } });
    return ok({ id: formId, deleted: true });
  })(_req);
}
