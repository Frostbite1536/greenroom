import type { UserRole } from "@prisma/client";
import { z } from "zod";
import type { ApiContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import {
  apiCredentialDisplayPrefix,
  MAX_ACTIVE_API_CREDENTIALS_PER_EVENT,
  MAX_API_CREDENTIAL_LABEL_LENGTH,
  type IssuedApiCredential,
} from "@/lib/services/api-credential";

/**
 * The three admin verbs for per-event API credentials, as a factory over their
 * dependencies (docs/ROADMAP.md, "Scoped credentials").
 *
 * `app/api/admin/api-keys/route.ts` is a wiring file: it supplies the real
 * Prisma client, the real session-backed `requireContext`, the real CSPRNG
 * issuer, and the real advisory lock, and exports what comes back. Everything
 * that decides anything lives here.
 *
 * That split exists so the handlers can be exercised at RUNTIME rather than
 * only pinned by source rails. `api-credential-handlers.test.ts` builds them
 * over a fake client and a fake context and calls them with real `Request`
 * objects, observing real `Response` statuses and bodies — which is how the
 * authorization matrix, the create/list/revoke lifecycle, and the issuance
 * bound are proved rather than asserted about.
 *
 * This module deliberately imports NO Prisma client and NO auth module: the
 * only mentions of either are `import type`, which erases. Importing it
 * therefore opens no database connection and reads no environment, so the test
 * needs neither.
 *
 * Every verb is ADMIN-only and scoped to `ctx.eventId` — the active event of
 * the signed session, never an event id from the request (INV-EVENT-001). No
 * route on this surface accepts an event selector at all, so a valid ADMIN of
 * one event has no reachable way to name another event's credential.
 *
 * Request shapes are declared here rather than in `types/api.ts`: this is an
 * operator-only panel with no other consumer, and the shared contract module is
 * load-bearing across every surface (AGENTS.md).
 */

const createSchema = z
  .object({
    label: z.string().trim().min(1, "Give the key a name.").max(MAX_API_CREDENTIAL_LABEL_LENGTH),
  })
  .strict();

/** The row shape every read on this surface projects. Note the absent digest. */
export type ApiCredentialRow = {
  id: string;
  label: string;
  lookupId: string;
  createdAt: Date;
  revokedAt: Date | null;
  createdBy: { name: string } | null;
};

/** The transaction surface issuance needs, and nothing more. */
export type ApiCredentialTx = {
  apiCredential: {
    count(args: { where: { eventId: string; revokedAt: null } }): Promise<number>;
    create(args: {
      data: {
        eventId: string;
        label: string;
        lookupId: string;
        secretHash: string;
        createdByUserId: string | null;
      };
      select: typeof credentialSelect;
    }): Promise<ApiCredentialRow>;
  };
};

/** The client surface these handlers use. Narrow on purpose: it is the whole
 * contract between this module and the database, and it is what a test fake
 * has to satisfy. */
export type ApiCredentialDb = {
  apiCredential: {
    findMany(args: {
      where: { eventId: string };
      orderBy: unknown;
      take: number;
      select: typeof credentialSelect;
    }): Promise<ApiCredentialRow[]>;
    findFirst(args: {
      where: { id: string; eventId: string };
      select: typeof credentialSelect;
    }): Promise<ApiCredentialRow | null>;
    updateMany(args: {
      where: { id: string; eventId: string; revokedAt: null };
      data: { revokedAt: Date };
    }): Promise<{ count: number }>;
  };
  $transaction<T>(fn: (tx: ApiCredentialTx) => Promise<T>): Promise<T>;
};

export type ApiCredentialDeps = {
  db: ApiCredentialDb;
  requireContext: (roles: UserRole[]) => Promise<ApiContext>;
  issue: () => IssuedApiCredential;
  lockIssuance: (tx: ApiCredentialTx, eventId: string) => Promise<void>;
  /** Injected so a test can assert the exact tombstone that was written. */
  now?: () => Date;
};

/**
 * The listing projection. `secretHash` is absent by construction rather than by
 * omission: this object is the only `select` any read here uses.
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

export function serializeCredential(row: ApiCredentialRow) {
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
 * A unique-constraint violation from the credential insert.
 *
 * `ApiCredential` has exactly one unique column, `lookupId`, so on this insert
 * P2002 can only mean two issued credentials drew the same 8-byte identifier.
 * That is rare enough to report as retryable rather than handle with a loop:
 * the caller presses the button again and draws a fresh one.
 *
 * Recognised STRUCTURALLY rather than with
 * `instanceof Prisma.PrismaClientKnownRequestError`, so this module keeps the
 * property that makes it testable — it imports no Prisma runtime, opens no
 * connection, and reads no environment. `api-credential-handlers.test.ts`
 * constructs a REAL `PrismaClientKnownRequestError` and asserts both that this
 * predicate accepts it and that a different Prisma error code is rejected, so
 * the structural check cannot drift away from the type it stands for.
 */
export function isApiCredentialCollision(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "PrismaClientKnownRequestError" && candidate.code === "P2002";
}

/** Never cache a listing of an event's credential metadata. */
function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export function createApiCredentialHandlers(deps: ApiCredentialDeps) {
  const clock = deps.now ?? (() => new Date());

  /**
   * GET — this event's credentials, live and revoked.
   *
   * Newest first, capped, with an honest `truncated` flag rather than a
   * refusal: revoked rows accumulate forever and an organizer must never lose
   * access to the panel that revokes their keys.
   */
  const list = handle(async () => {
    const ctx = await deps.requireContext(["ADMIN"]);
    const rows = await deps.db.apiCredential.findMany({
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
   * POST — issue one credential for the active event.
   *
   * The plaintext token is in this response body and nowhere else in the
   * system. Counting and inserting happen inside one transaction behind an
   * event-scoped advisory lock, so the active bound holds against two admins
   * pressing create at the same moment rather than merely against one admin
   * pressing it twice.
   */
  const create = handle(async (req) => {
    const ctx = await deps.requireContext(["ADMIN"]);
    const input = await parseBody(req, createSchema);

    const issued = deps.issue();
    let credential: ApiCredentialRow;
    try {
      credential = await deps.db.$transaction(async (tx) => {
        await deps.lockIssuance(tx, ctx.eventId);
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
        // Only the lookup half and the secret's digest are persisted.
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
      });
    } catch (error) {
      // The collision contract has to be honoured HERE, inside the boundary
      // `handle()` wraps. A caller of these handlers only ever receives a
      // Response, so an outer catch can never see this error: mapping it
      // anywhere but here silently becomes a 500.
      //
      // The body is a bounded named envelope and carries no credential
      // material — not the token, not the secret, not the digest, and not even
      // the colliding lookup id, which would tell a caller a value they never
      // held is already taken.
      if (isApiCredentialCollision(error)) {
        throw new ApiError(409, "API_KEY_RETRY", "Could not issue a key just now. Try again.");
      }
      // The bound's own 409, and anything genuinely unknown, fall through
      // untouched — the latter to the generic 500, which is what it is for.
      throw error;
    }

    // `issued.token` is returned here and then forgotten by the server. No
    // later read of this row can reproduce it.
    return ok({ credential: serializeCredential(credential), token: issued.token }, 201);
  });

  /**
   * DELETE ?id= — revoke, keeping the row.
   *
   * Idempotent: revoking an already-revoked credential succeeds and changes
   * nothing, so a double-click or a retried request is not an error. The scope
   * is inside the `updateMany` predicate, so an unknown id and another event's
   * id produce the identical 404 and neither confirms the other event's row
   * exists.
   */
  const revoke = handle(async (req) => {
    const ctx = await deps.requireContext(["ADMIN"]);
    const id = new URL(req.url).searchParams.get("id");
    if (!id) throw new ApiError(400, "MISSING_API_KEY", "id is required.");

    // One statement decides both scope and idempotence: it sets `revokedAt`
    // only on a still-live credential of THIS event, and reports how many rows
    // that was. Zero rows is either "already revoked" or "not ours", and the
    // scoped re-read below tells those apart without ever widening the scope.
    const updated = await deps.db.apiCredential.updateMany({
      where: { id, eventId: ctx.eventId, revokedAt: null },
      data: { revokedAt: clock() },
    });

    const credential = await deps.db.apiCredential.findFirst({
      where: { id, eventId: ctx.eventId },
      select: credentialSelect,
    });
    if (!credential) throw new ApiError(404, "API_KEY_NOT_FOUND", "API key not found.");

    return ok({ credential: serializeCredential(credential), revoked: updated.count > 0 });
  });

  return {
    GET: async (req: Request): Promise<Response> => noStore(await list(req)),
    POST: async (req: Request): Promise<Response> => noStore(await create(req)),
    DELETE: async (req: Request): Promise<Response> => noStore(await revoke(req)),
  };
}
