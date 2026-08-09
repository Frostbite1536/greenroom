import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok } from "@/lib/api/http";
import { serializeForm } from "@/lib/api/form-serialize";
import { lockFormConfigForShapeWrite } from "@/lib/services/form-config-lock";
import { lockAndReadFormDeleteUsage } from "@/lib/services/form-delete-lock";
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

function formInUse(): ApiError {
  return new ApiError(409, "FORM_HAS_ABSTRACTS", "This form is in use and cannot be deleted.");
}

/** DELETE /api/cfp/forms/:formId — remove only a form with no retained history (admin). */
export function DELETE(_req: Request, ctx: Params) {
  return handle(async () => {
    const auth = await requireContext(["ADMIN"]);
    const { formId } = await ctx.params;
    try {
      await prisma.$transaction(async (tx) => {
        // LOCK-ORDER-v1: FormConfig FOR UPDATE, sorted FormFields FOR UPDATE,
        // then sorted linked OnboardingTask rows. Fresh usage reads only happen
        // after that final child lock, before the destructive delete.
        const existing = await lockFormConfigForShapeWrite(tx, formId);
        const form = requireEventOwnedRow(existing, auth.eventId, "FORM_NOT_FOUND", "Form");
        const usage = await lockAndReadFormDeleteUsage(tx, form.id);
        if (usage.hasAbstract || usage.hasLinkedTask) throw formInUse();
        await tx.formConfig.delete({ where: { id: form.id } });
      });
    } catch (error) {
      // The route's only write is FormConfig deletion. Preserve a stable,
      // actionable result if a final Restrict FK race reaches PostgreSQL.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
        throw formInUse();
      }
      throw error;
    }
    return ok({ id: formId, deleted: true });
  })(_req);
}
