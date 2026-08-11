import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
import { ApiError, toResponse } from "@/lib/api/http";
import { issueApiCredential } from "@/lib/services/api-credential";
import { lockEventApiCredentialIssuance } from "@/lib/services/api-credential-store";
import {
  createApiCredentialHandlers,
  type ApiCredentialDb,
  type ApiCredentialTx,
} from "@/lib/services/api-credential-handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Self-serve per-event credentials for the read-only v1 API
 * (docs/ROADMAP.md, "Scoped credentials").
 *
 * This file is wiring only. Every decision — the ADMIN check, the event
 * scoping, the issuance bound and its lock, the revoke semantics, and the
 * projection that keeps the stored digest out of every response — lives in
 * `lib/services/api-credential-handlers.ts`, where it is exercised at runtime
 * over a fake client by `api-credential-handlers.test.ts`.
 */

/**
 * The single seam between the generated Prisma client and the narrow view these
 * handlers take of it.
 *
 * `ApiCredentialDb` names exactly the four calls they make. The generated
 * delegate's signatures are heavily generic over `select` inference, so they do
 * not line up structurally with a concrete one; this cast is where that is
 * reconciled, once, in the open. It widens nothing at runtime — the handlers
 * can still only reach the four methods the interface names.
 */
const db = prisma as unknown as ApiCredentialDb;

const handlers = createApiCredentialHandlers({
  db,
  requireContext,
  issue: issueApiCredential,
  // The advisory lock is a dependency so the handlers module never imports the
  // Prisma-backed store, which keeps it importable without a database.
  lockIssuance: (tx, eventId) =>
    lockEventApiCredentialIssuance(tx as unknown as Prisma.TransactionClient, eventId),
});

/**
 * The only Prisma failure this route interprets: a collision on the unique
 * lookup id, which at 8 random bytes is rare enough to report as retryable
 * rather than handle with a loop. Everything else surfaces as itself.
 */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function withRetryableCollision(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (isUniqueViolation(error)) {
      return toResponse(new ApiError(409, "API_KEY_RETRY", "Could not issue a key just now. Try again."));
    }
    throw error;
  }
}

export const GET = handlers.GET;
export const POST = async (req: Request): Promise<Response> =>
  withRetryableCollision(() => handlers.POST(req));
export const DELETE = handlers.DELETE;

export type { ApiCredentialDb, ApiCredentialTx };
