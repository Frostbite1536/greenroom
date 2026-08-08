import { prisma } from "@/lib/prisma";
import { ApiError, handle, ok } from "@/lib/api/http";
import { serializePublicForm } from "@/lib/api/form-serialize";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ formId: string }> };

/**
 * GET /api/cfp/public/:formId — public form for the CFP renderer. Works with a
 * null session. Only published forms are exposed; window state is derived
 * server-side (INV-FORM-001). Accepts either a form id or an event-scoped slug.
 */
export function GET(_req: Request, ctx: Params) {
  return handle(async () => {
    const { formId } = await ctx.params;
    const form = await prisma.formConfig.findFirst({
      where: { published: true, OR: [{ id: formId }, { slug: formId }] },
      include: {
        fields: true,
        event: {
          select: {
            categories: {
              select: { id: true, name: true },
              // `sortOrder` is the product-defined ordering; the remaining
              // keys make ties deterministic for public clients.
              orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
            },
          },
        },
      },
    });
    if (!form) {
      throw new ApiError(404, "FORM_NOT_FOUND", "This form is not available.");
    }
    return ok(serializePublicForm(form));
  })(_req);
}
