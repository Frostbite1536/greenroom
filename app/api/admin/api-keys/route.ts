import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import {
  apiCredentialDisplayPrefix,
  issueApiCredential,
  MAX_ACTIVE_API_CREDENTIALS_PER_EVENT,
  MAX_API_CREDENTIAL_LABEL_LENGTH,
} from "@/lib/services/api-credential";
import { lockEventApiCredentialIssuance } from "@/lib/services/api-credential-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Self-serve per-event credentials for the read-only v1 API
 * (docs/ROADMAP.md, "Scoped credentials").
 *
 * Every verb here is ADMIN-only and scoped to `ctx.eventId` — the active event
 * of the signed session, never an event id from the request (INV-EVENT-001).
 * There is no route on this surface that takes an event selector, so a valid
 * ADMIN of one event has no reachable way to name another event's credential.
 *
 * The request shapes are declared locally rather than in `types/api.ts`: this
 * is an operator-only panel with no other consumer, and the shared contract
 * module is load-bearing across every surface (AGENTS.md).
 *
 * The issued token appears exactly once, in the POST response, and never
 * again — not in the listing, not in a URL, not in a log line. `DELETE` takes
 * the credential's `id`, never the token, precisely so no credential material
 * ever reaches a query string, an access log, or a `Referer` header.
 */

const createSchema = z
  .object({
    label: z.string().trim().min(1, "Give the key a name.").max(MAX_API_CREDENTIAL_LABEL_LENGTH),
  })
  .strict();

/**
 * The listing projection. `secretHash` is absent by construction rather than by
 * omission: this object is the only `select` any read on this route uses, and
 * `lib/services/api-credential.source.test.ts` fails if the digest column is
 * ever named outside the authentication path.
 *
 * `lookupId` IS selected, and that is safe by design — it is the non-secret
 * half of the token, and showing it is the whole point of the list.
 */
const credentialSelect = {
  id: true,
  label: true,
  lookupId: true,
  createdAt: true,
  revokedAt: true,
  createdBy: { select: { name: true } },
} as const;

type CredentialRow = {
  id: string;
  label: string;
  lookupId: string;
  createdAt: Date;
  revokedAt: Date | null;
  createdBy: { name: string } | null;
};

function serializeCredential(row: CredentialRow) {
  return {
    id: row.id,
    label: row.label,
    // Derived, never stored: the visible half of the token, and nothing else.
    tokenPrefix: apiCredentialDisplayPrefix(row.lookupId),
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    // The creator may have been removed from the deployment since; the
    // credential outlives them, so the row stays readable without a name.
    createdBy: row.createdBy?.name ?? null,
  };
}

/**
 * The only Prisma failure this route interprets: a collision on the unique
 * lookup id. Everything else must surface as itself.
 */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** Never cache a listing of an event's credential metadata. */
function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

/**
 * GET /api/admin/api-keys — this event's credentials, live and revoked.
 *
 * Newest first, capped, with an honest `truncated` flag rather than a refusal:
 * revoked rows accumulate forever and an organizer must never lose access to
 * the panel that revokes their keys.
 */
const list = handle(async () => {
  const ctx = await requireContext(["ADMIN"]);
  const rows = await prisma.apiCredential.findMany({
    where: { eventId: ctx.eventId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: OPERATOR_QUERY_LIMITS.settingsApiCredentials + 1,
    select: credentialSelect,
  });
  const page = rows.slice(0, OPERATOR_QUERY_LIMITS.settingsApiCredentials);
  return ok({
    credentials: page.map(serializeCredential),
    truncated: rows.length > OPERATOR_QUERY_LIMITS.settingsApiCredentials,
    activeLimit: MAX_ACTIVE_API_CREDENTIALS_PER_EVENT,
  });
});

/**
 * POST /api/admin/api-keys — issue one credential for the active event.
 *
 * The plaintext token is in this response body and nowhere else in the system.
 * Counting and inserting happen inside one transaction behind an event-scoped
 * advisory lock, so the active bound holds against two admins pressing create
 * at the same moment rather than merely against one admin pressing it twice.
 */
const create = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, createSchema);

  const issued = issueApiCredential();
  const credential = await prisma.$transaction(async (tx) => {
    await lockEventApiCredentialIssuance(tx, ctx.eventId);
    const active = await tx.apiCredential.count({
      where: { eventId: ctx.eventId, revokedAt: null },
    });
    if (active >= MAX_ACTIVE_API_CREDENTIALS_PER_EVENT) {
      throw new ApiError(
        409,
        "API_KEY_LIMIT_REACHED",
        `This event already has ${MAX_ACTIVE_API_CREDENTIALS_PER_EVENT} active API keys. Revoke one before creating another.`,
        { label: ["Revoke an existing key first."] },
      );
    }
    // Only the lookup half and the secret's digest are persisted. The insert
    // can fail on the unique lookup id, which at 8 random bytes is a collision
    // so rare it is reported as retryable rather than handled with a loop.
    return tx.apiCredential.create({
      data: {
        eventId: ctx.eventId,
        label: input.label,
        lookupId: issued.lookupId,
        secretHash: issued.secretHash,
        createdByUserId: ctx.userId,
      },
      select: credentialSelect,
    });
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) {
      throw new ApiError(409, "API_KEY_RETRY", "Could not issue a key just now. Try again.");
    }
    throw error;
  });

  // `issued.token` is returned here and then forgotten by the server. No later
  // read of this row can reproduce it.
  return ok({ credential: serializeCredential(credential), token: issued.token }, 201);
});

/**
 * DELETE /api/admin/api-keys?id= — revoke, keeping the row.
 *
 * Idempotent: revoking an already-revoked credential succeeds and changes
 * nothing, so a double-click or a retried request is not an error. The scope is
 * inside the `updateMany` predicate, so an unknown id and another event's id
 * produce the identical 404 and neither confirms the other event's row exists.
 */
const revoke = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const id = new URL(req.url).searchParams.get("id");
  if (!id) throw new ApiError(400, "MISSING_API_KEY", "id is required.");

  // One statement decides both scope and idempotence: it sets `revokedAt` only
  // on a still-live credential of THIS event, and reports how many rows that
  // was. Zero rows is either "already revoked" or "not ours", and the scoped
  // re-read below tells those apart without ever widening the scope.
  const updated = await prisma.apiCredential.updateMany({
    where: { id, eventId: ctx.eventId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  const credential = await prisma.apiCredential.findFirst({
    where: { id, eventId: ctx.eventId },
    select: credentialSelect,
  });
  if (!credential) throw new ApiError(404, "API_KEY_NOT_FOUND", "API key not found.");

  return ok({ credential: serializeCredential(credential), revoked: updated.count > 0 });
});

export const GET = async (req: Request): Promise<Response> => noStore(await list(req));
export const POST = async (req: Request): Promise<Response> => noStore(await create(req));
export const DELETE = async (req: Request): Promise<Response> => noStore(await revoke(req));
