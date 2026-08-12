import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
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
 * No error handling lives here, deliberately.
 *
 * An earlier version of this file wrapped POST to map a P2002 lookup-id
 * collision onto `409 API_KEY_RETRY`. That wrapper could never fire: the
 * handlers are built on `handle()`, so they RESOLVE to a Response rather than
 * throwing, and the collision had already been turned into a 500 before this
 * file saw it. The contract now lives inside the handler boundary, where it can
 * actually be honoured, and `api-credential-handlers.test.ts` drives a real
 * `PrismaClientKnownRequestError` through it to prove so.
 */
export const GET = handlers.GET;
export const POST = handlers.POST;
export const DELETE = handlers.DELETE;

export type { ApiCredentialDb, ApiCredentialTx };
