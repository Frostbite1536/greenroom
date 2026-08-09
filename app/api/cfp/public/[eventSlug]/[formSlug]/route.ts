import { ApiError, handle, ok } from "@/lib/api/http";
import { serializePublicForm } from "@/lib/api/form-serialize";
import { resolvePublishedPublicForm } from "@/lib/services/public-form-resolver";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ eventSlug: string; formSlug: string }> };

/**
 * GET /api/cfp/public/:eventSlug/:formSlug — the canonical, event-scoped
 * public CFP projection. The shared resolver makes every unavailable form
 * indistinguishable from an unknown event or cross-event slug pair.
 */
export function GET(req: Request, ctx: Params) {
  return handle(async () => {
    const { eventSlug, formSlug } = await ctx.params;
    const form = await resolvePublishedPublicForm({ eventSlug, formSlug });
    if (!form) {
      throw new ApiError(404, "FORM_NOT_FOUND", "This form is not available.");
    }
    return ok(serializePublicForm(form));
  })(req);
}
