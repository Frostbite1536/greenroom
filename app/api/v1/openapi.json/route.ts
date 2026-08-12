import { OPENAPI_DOCUMENT } from "@/lib/api/openapi";

/**
 * The only route on this surface that takes no key — deliberately.
 *
 * It serves a static contract description. There is no `authorizeV1Request`
 * call here and no prisma import, so it cannot read an event, cannot return
 * programme data, and cannot be turned into an unauthenticated probe for which
 * events exist. Gating it would only stop an integrator reading the contract
 * that tells them they need a key.
 *
 * It is also the reason the surface can be advertised at all before an
 * integrator holds any credential: the three list routes still refuse every
 * uncredentialed request with 401, and this one still explains how to get a key
 * — either the deployment-wide `GREENROOM_API_KEY` from the operator, or a
 * per-event key from the event's own organizer.
 *
 * The segment is literally named `openapi.json` so the published URL carries
 * the extension integrators and spec tooling expect. `force-static` holds
 * because `OPENAPI_DOCUMENT` and its whole transitive import graph are pure —
 * `lib/api/openapi-purity.test.ts` proves that rather than trusting this
 * comment.
 */
export const dynamic = "force-static";
export const runtime = "nodejs";

/** GET /api/v1/openapi.json */
export function GET(): Response {
  return Response.json(OPENAPI_DOCUMENT);
}
