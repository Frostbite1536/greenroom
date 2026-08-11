import { prisma } from "@/lib/prisma";
import { resourceWikiInputSchema, resourceWikiUpdateSchema } from "@/types/api";
import { assertEventScope, requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { assertEventQueryBound, OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import { requireEventOwnedRow } from "@/lib/services/event-owned-row";
import { classifyResourceMutationError } from "@/lib/services/resource-mutation-errors";
import {
  ADMIN_RESOURCE_ORDER,
  prepareResourceHtml,
  resourceSummaryValue,
  serializeResource,
} from "@/lib/services/resource-wiki";

export const dynamic = "force-dynamic";

/**
 * Resource / wiki page authoring (buyer requirement 8).
 *
 * The speaker portal has always RENDERED these pages; until now the only writer
 * was the demo seed, so an organizer could not create one in the product. This
 * route is that writer.
 *
 * Three properties it holds, in the same shapes the neighbouring operator
 * routes hold them:
 *
 *  - ADMIN-only and event-scoped from the session. The create body carries an
 *    `eventId` (the shared contract's `resourceWikiInputSchema` always has), so
 *    it is checked with `assertEventScope` and then DISCARDED — the row is
 *    written with `ctx.eventId`. Edits and deletes take scope from the stored
 *    row read under its own `FOR UPDATE` lock (S1), so an id from another event
 *    is indistinguishable from an unknown one.
 *  - INV-HTML-001 at write time. Every body goes through `prepareResourceHtml`
 *    before it is stored, so a script/style/embed payload never reaches the
 *    column. The portal reader still sanitizes on render — rows also arrive
 *    from the seed, and defence in depth is the point.
 *  - `@@unique([eventId, slug])` is surfaced as a named 409 rather than leaking
 *    a Prisma uniqueness violation as a 500, matching `ROOM_NAME_TAKEN` and
 *    `TASK_TITLE_TAKEN`.
 */
const resourceSelect = {
  id: true,
  slug: true,
  title: true,
  summary: true,
  htmlContent: true,
  published: true,
  updatedAt: true,
} as const;

function slugTakenError(): ApiError {
  return new ApiError(409, "RESOURCE_SLUG_TAKEN", "Another resource page in this event already uses that web address.", {
    slug: ["This web address is already in use."],
  });
}

/** Sanitize for storage, or refuse with the named reason. */
function storedHtml(rawHtml: string): string {
  const decision = prepareResourceHtml(rawHtml);
  if (!decision.allowed) {
    throw new ApiError(422, decision.code, decision.message, { htmlContent: [decision.message] });
  }
  return decision.html;
}

/** GET /api/admin/resources — every resource page of the active event, drafts included. */
export const GET = handle(async () => {
  const ctx = await requireContext(["ADMIN"]);
  const resources = await prisma.resourceWiki.findMany({
    where: { eventId: ctx.eventId },
    orderBy: ADMIN_RESOURCE_ORDER,
    take: OPERATOR_QUERY_LIMITS.adminResources + 1,
    select: resourceSelect,
  });
  assertEventQueryBound(resources, OPERATOR_QUERY_LIMITS.adminResources, "resource pages");
  return ok({ resources: resources.map(serializeResource) });
});

/** POST /api/admin/resources — author a new resource page for the active event. */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, resourceWikiInputSchema);
  // The body's event id may only ever name the caller's own active event, and
  // is not what the row is written with.
  assertEventScope(ctx, input.eventId);

  try {
    const resource = await prisma.resourceWiki.create({
      data: {
        eventId: ctx.eventId,
        slug: input.slug,
        title: input.title,
        summary: resourceSummaryValue(input.summary),
        htmlContent: storedHtml(input.htmlContent),
        published: input.published,
      },
      select: resourceSelect,
    });
    return ok({ resource: serializeResource(resource) }, 201);
  } catch (error) {
    if (classifyResourceMutationError(error) === "RESOURCE_SLUG_TAKEN") throw slugTakenError();
    throw error;
  }
});

/**
 * PATCH /api/admin/resources — edit a resource page, including the publish
 * toggle.
 *
 * The stored `eventId` is re-read under the same exclusive lock that authorizes
 * the write, so a caller-supplied id can never reach another event's row.
 */
export const PATCH = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, resourceWikiUpdateSchema);

  try {
    const resource = await prisma.$transaction(async (tx) => {
      const [existing] = await tx.$queryRaw<{ id: string; eventId: string }[]>`
        SELECT "id", "eventId" FROM "ResourceWiki" WHERE "id" = ${input.id} FOR UPDATE
      `;
      const owned = requireEventOwnedRow(existing, ctx.eventId, "RESOURCE_NOT_FOUND", "Resource page");
      return tx.resourceWiki.update({
        where: { id: owned.id },
        data: {
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.summary !== undefined ? { summary: resourceSummaryValue(input.summary) } : {}),
          ...(input.htmlContent !== undefined ? { htmlContent: storedHtml(input.htmlContent) } : {}),
          ...(input.published !== undefined ? { published: input.published } : {}),
        },
        select: resourceSelect,
      });
    });
    return ok({ resource: serializeResource(resource) });
  } catch (error) {
    const mutationError = classifyResourceMutationError(error);
    if (mutationError === "RESOURCE_SLUG_TAKEN") throw slugTakenError();
    // The scoped preflight can be invalidated by a concurrent delete. Keep that
    // race indistinguishable from an unknown or cross-event resource id.
    if (mutationError === "RESOURCE_NOT_FOUND") {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "Resource page not found.");
    }
    throw error;
  }
});

/**
 * DELETE /api/admin/resources?resourceId= — remove a resource page.
 *
 * `ResourceWiki` owns nothing and nothing references it, so there is no
 * retained history to protect the way `ROOM_IN_USE` or `TASK_HAS_RESPONSES`
 * protect theirs — the confirmation lives in the UI. Scope is still part of the
 * locked query, so cross-event and unknown ids produce the same 404.
 */
export const DELETE = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const resourceId = new URL(req.url).searchParams.get("resourceId");
  if (!resourceId) throw new ApiError(400, "MISSING_RESOURCE", "resourceId is required.");

  const resource = await prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id"
      FROM "ResourceWiki"
      WHERE "id" = ${resourceId} AND "eventId" = ${ctx.eventId}
      FOR UPDATE
    `;
    if (!locked) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Resource page not found.");
    return tx.resourceWiki.delete({ where: { id: locked.id }, select: resourceSelect });
  });

  return ok({ resource: serializeResource(resource) });
});
