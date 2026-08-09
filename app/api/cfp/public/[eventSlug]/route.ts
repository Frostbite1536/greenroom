import { ApiError, handle } from "@/lib/api/http";
import {
  canonicalPublicFormApiPath,
  resolveLegacyPublishedPublicForm,
} from "@/lib/services/public-form-resolver";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ eventSlug: string }> };

/**
 * GET /api/cfp/public/:legacyToken — compatibility route for one-segment
 * public links. The filesystem segment is named `eventSlug` to match its
 * canonical nested child, but its value remains an opaque legacy ID-or-slug.
 */
export function GET(req: Request, ctx: Params) {
  return handle(async () => {
    const { eventSlug: legacyToken } = await ctx.params;
    const scope = await resolveLegacyPublishedPublicForm(legacyToken);
    if (!scope) {
      throw new ApiError(404, "FORM_NOT_FOUND", "This form is not available.");
    }
    return Response.redirect(new URL(canonicalPublicFormApiPath(scope), req.url), 307);
  })(req);
}
