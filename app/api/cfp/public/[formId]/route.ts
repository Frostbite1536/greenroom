import { ApiError, handle } from "@/lib/api/http";
import {
  canonicalPublicFormApiPath,
  resolveLegacyPublishedPublicForm,
} from "@/lib/services/public-form-resolver";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ formId: string }> };

/**
 * GET /api/cfp/public/:formId — compatibility route for one-segment public
 * links. It redirects only a published exact ID or an unambiguous published
 * legacy slug; collisions and unavailable forms deliberately fail closed.
 */
export function GET(req: Request, ctx: Params) {
  return handle(async () => {
    const { formId } = await ctx.params;
    const scope = await resolveLegacyPublishedPublicForm(formId);
    if (!scope) {
      throw new ApiError(404, "FORM_NOT_FOUND", "This form is not available.");
    }
    return Response.redirect(new URL(canonicalPublicFormApiPath(scope), req.url), 307);
  })(req);
}
