import { createHash, timingSafeEqual } from "node:crypto";
import {
  DEFAULT_V1_LIMIT,
  MAX_V1_EVENT_SELECTOR_LENGTH,
  MAX_V1_LIMIT,
  MAX_V1_OFFSET,
  MAX_V1_SUBMISSION_ID_LENGTH,
  V1_API_VERSION,
} from "@/lib/api/v1-contract";
import { getV1ApiKey } from "@/lib/env";
import { apiCredentialSecretMatches, parseApiCredentialToken } from "@/lib/services/api-credential";
import { findActiveApiCredential } from "@/lib/services/api-credential-store";

/**
 * The bounds enforced below are declared once, in the pure
 * `lib/api/v1-contract` module, and re-exported here so existing importers keep
 * a single import site. The published OpenAPI document reads the same numbers
 * without importing this runtime module, which is what keeps the contract
 * endpoint free of an env/auth/Prisma graph.
 */
export {
  DEFAULT_V1_LIMIT,
  MAX_V1_EVENT_SELECTOR_LENGTH,
  MAX_V1_LIMIT,
  MAX_V1_OFFSET,
  MAX_V1_SUBMISSION_ID_LENGTH,
  V1_API_VERSION,
};

export type V1ListQuery = {
  event: string;
  limit: number;
  offset: number;
};

export type V1EventQuery = { event: string };

type V1Failure = {
  status: number;
  code: string;
  message: string;
};

export type V1EventMeta = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
};

export type V1PaginationMeta = {
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
  nextOffset: number | null;
};

/**
 * Reads either supported API-key credential style. Bearer takes precedence
 * when both are sent, so a malformed Bearer credential cannot be bypassed by
 * an unrelated header.
 */
export function getV1RequestKey(headers: Headers): string | null {
  const authorization = headers.get("authorization");
  if (authorization !== null) {
    return authorization.trim().match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || null;
  }
  return headers.get("x-api-key")?.trim() || null;
}

/** Compare fixed-size hashes to avoid leaking API-key length or prefix data. */
export function keysMatch(expected: string, received: string): boolean {
  const expectedHash = createHash("sha256").update(expected).digest();
  const receivedHash = createHash("sha256").update(received).digest();
  return timingSafeEqual(expectedHash, receivedHash);
}

/**
 * What an accepted credential is allowed to read.
 *
 * `global` is the deployment-wide `GREENROOM_API_KEY`: it is not event-scoped
 * and may address any event, exactly as it always could. `event` is a per-event
 * `ApiCredential` and may address one event and no other.
 */
export type V1AuthScope = { kind: "global" } | { kind: "event"; eventId: string };

export type V1Authorization =
  | { ok: true; scope: V1AuthScope }
  | { ok: false; error: V1Failure };

/**
 * Resolves a presented token to a live per-event credential, or null. Injected
 * so the truth table below is provable without a database.
 */
export type V1CredentialLookup = (
  token: string,
) => Promise<{ eventId: string; secretHash: string } | null>;

function v1Unauthorized(): V1Failure {
  return { status: 401, code: "UNAUTHORIZED", message: "A valid API key is required." };
}

/**
 * Authenticates before the event selector is resolved and before any programme
 * data is read.
 *
 * Two credential mechanisms are accepted, and this table is the whole of it.
 * "presented" means the request carried a usable Bearer or `X-API-Key` value at
 * all; "global" means `GREENROOM_API_KEY` is set and long enough to be usable.
 *
 *   global | presented | presented value        | result
 *   -------|-----------|------------------------|------------------------------
 *   no     | no        | --                     | 401
 *   yes    | no        | --                     | 401
 *   yes    | yes       | equals the global key  | authorized for any event
 *   yes    | yes       | anything else          | credential resolution, below
 *   no     | yes       | anything               | credential resolution, below
 *
 * Credential resolution: the value is parsed as `grk_<lookupId>_<secret>`, the
 * live row with that non-secret lookup id is fetched by a single indexed point
 * read, and the presented secret is compared to the stored digest in constant
 * time. A match authorizes exactly that credential's event and nothing else. A
 * value that does not parse, a lookup id that matches nothing, a credential
 * that has been revoked, a wrong secret, and a valid credential aimed at
 * another event all end at the same 401 as a wrong global key — same status,
 * same body, no way to tell them apart.
 *
 * ## There is no 503 on this path, and that is the point
 *
 * This surface used to answer `503 API_KEY_NOT_CONFIGURED` when no
 * `GREENROOM_API_KEY` was set. That was a true statement when the deployment-wide
 * key was the ONLY way in: no key configured really did mean nothing was
 * configured. It stopped being true the moment an event could hold its own
 * credentials, because a deployment can now be fully configured — organizers
 * issuing and revoking working keys all day — with `GREENROOM_API_KEY` unset. To
 * such a deployment, answering "this server is not configured" to a caller who
 * simply forgot their key is a false claim about the server's own state.
 *
 * So every missing-or-invalid credential on this surface is now 401. The surface
 * is deployed and reachable, so it authenticates rather than declaring itself
 * unconfigured, and the caller is told the true thing: their credential is the
 * problem. Nothing here can return 503 any more, and the published contract no
 * longer advertises it.
 *
 * Nothing else changes. 503 is reserved for an explicit auth-surface-disabled
 * configuration, and no such flag exists today, so on this path it is simply
 * gone. The unrelated fail-closed 503s elsewhere in the application — the
 * reviewer-invite signing-secret case in
 * `app/api/evaluations/reviewer-invites/link/route.ts`, which reports
 * `INVITE_UNAVAILABLE` when no signing secret or app URL is configured — are a
 * different surface with a different meaning and are deliberately untouched.
 *
 * Three further properties of the table are deliberate and worth naming:
 *
 *   - A presented value is always resolved against stored credentials, even
 *     when no global key is configured. Per-event credentials are the point of
 *     this feature: requiring a deployment-wide key before they work would make
 *     the scoped mechanism depend on the unscoped one.
 *   - Header precedence is untouched and is decided FIRST, by `getV1RequestKey`
 *     above, before any credential parsing. A malformed `Authorization` value is
 *     still a failure that an unrelated `X-API-Key` cannot rescue, exactly as
 *     before, and that is true for both mechanisms.
 *   - The deployment-wide key is still checked first and still costs no
 *     database work. Authenticating a `grk_` credential does cost one indexed
 *     point read; the published contract says so rather than continuing to
 *     claim the whole surface refuses before touching the database.
 *
 * The wrong-event half of the refusal is enforced by `v1EventWhere` and
 * `authorizeV1EventScope` below, which together keep another event's row out of
 * the query entirely rather than reading it and refusing afterwards.
 */
export async function authorizeV1Request(
  headers: Headers,
  configuredKey = getV1ApiKey(),
  findCredential: V1CredentialLookup = findActiveApiCredential,
): Promise<V1Authorization> {
  // Header precedence, unchanged and first: this decides WHICH value is the
  // presented credential before anything looks at what the value contains.
  const requestKey = getV1RequestKey(headers);
  if (!requestKey) {
    // No credential at all. An auth failure, never a claim about how this
    // deployment is configured — it may be serving per-event keys perfectly.
    return { ok: false, error: v1Unauthorized() };
  }

  // The deployment-wide key next, byte for byte as before: one fixed-size
  // constant-time digest comparison, no parsing, no database work.
  if (configuredKey && keysMatch(configuredKey, requestKey)) {
    return { ok: true, scope: { kind: "global" } };
  }

  // Parse, then ONE indexed point read on the non-secret lookup id, then a
  // constant-time comparison of the secret's digest. Never a scan over an
  // event's credentials (`lib/services/api-credential.ts` has the reasoning).
  const parsed = parseApiCredentialToken(requestKey);
  if (parsed) {
    const credential = await findCredential(requestKey);
    if (credential && apiCredentialSecretMatches(credential.secretHash, parsed.secret)) {
      return { ok: true, scope: { kind: "event", eventId: credential.eventId } };
    }
  }

  return { ok: false, error: v1Unauthorized() };
}

/**
 * The `where` that resolves the `event` selector, narrowed by what the accepted
 * credential is allowed to see.
 *
 * A global key resolves the selector across every event, as it always has. An
 * event-scoped credential resolves it only within its OWN event: the credential's
 * event id is part of the predicate, so a selector naming somebody else's event
 * matches no row and that event's data is never read. The refusal is decided by
 * the absence of a row, not by reading a row and then rejecting it — which is
 * what keeps a per-event credential from being an enumeration oracle for the
 * deployment's other events.
 */
export function v1EventWhere(scope: V1AuthScope, selector: string): V1EventWhereInput {
  const bySelector: V1EventSelectorMatch = { OR: [{ id: selector }, { slug: selector }] };
  return scope.kind === "event" ? { AND: [bySelector, { id: scope.eventId }] } : bySelector;
}

/** The selector half on its own: this is what a deployment-wide key resolves. */
type V1EventSelectorMatch = { OR: ({ id: string } | { slug: string })[] };

/**
 * Structural rather than `Prisma.EventWhereInput`: this module stays free of a
 * generated-client type, and the shape is narrow enough that a widening edit
 * would not typecheck against the route's `findFirst` either.
 */
export type V1EventWhereInput =
  | V1EventSelectorMatch
  | { AND: (V1EventSelectorMatch | { id: string })[] };

/**
 * Turns the result of that scoped resolution into a response decision.
 *
 * With a global key, no row means the selector names nothing: 404. With an
 * event-scoped credential, no row means the selector was not this credential's
 * event — whether because no such event exists or because it belongs to someone
 * else, which are indistinguishable here BECAUSE the query could not have
 * matched anything else. That is refused as 401, the same refusal a wrong key
 * gets, so nothing about the deployment's other events is disclosed.
 *
 * The final identity check is redundant against `v1EventWhere` and kept anyway:
 * if a future edit widens that predicate, this is the assertion that fails
 * closed instead of quietly serving another event's programme.
 */
export function authorizeV1EventScope<T extends { id: string }>(
  scope: V1AuthScope,
  event: T | null,
): { ok: true; event: T } | { ok: false; error: V1Failure } {
  if (scope.kind === "event" && event?.id !== scope.eventId) {
    return { ok: false, error: v1Unauthorized() };
  }
  if (!event) {
    return {
      ok: false,
      error: { status: 404, code: "EVENT_NOT_FOUND", message: "Event not found." },
    };
  }
  return { ok: true, event };
}

/** Parses the shared required event selector and bounded offset pagination. */
export function parseV1ListQuery(searchParams: URLSearchParams):
  | { ok: true; value: V1ListQuery }
  | { ok: false; error: V1Failure } {
  const event = parseV1EventQuery(searchParams);
  if (!event.ok) return event;

  const limit = parseBoundedInteger(searchParams.get("limit"), DEFAULT_V1_LIMIT, 1, MAX_V1_LIMIT);
  if (limit === null) {
    return {
      ok: false,
      error: {
        status: 400,
        code: "INVALID_QUERY",
        message: `Query parameter 'limit' must be an integer from 1 to ${MAX_V1_LIMIT}.`,
      },
    };
  }

  const offset = parseBoundedInteger(searchParams.get("offset"), 0, 0, MAX_V1_OFFSET);
  if (offset === null) {
    return {
      ok: false,
      error: {
        status: 400,
        code: "INVALID_QUERY",
        message: `Query parameter 'offset' must be an integer from 0 to ${MAX_V1_OFFSET}.`,
      },
    };
  }

  return { ok: true, value: { event: event.value.event, limit, offset } };
}

/** Parse only the required event selector for a non-list v1 route. */
export function parseV1EventQuery(searchParams: URLSearchParams):
  | { ok: true; value: V1EventQuery }
  | { ok: false; error: V1Failure } {
  const event = searchParams.get("event")?.trim();
  if (!event) {
    return { ok: false, error: { status: 400, code: "EVENT_REQUIRED", message: "Query parameter 'event' is required." } };
  }
  if (event.length > MAX_V1_EVENT_SELECTOR_LENGTH) {
    return { ok: false, error: { status: 400, code: "INVALID_QUERY", message: "Query parameter 'event' is too long." } };
  }
  return { ok: true, value: { event } };
}

function parseBoundedInteger(raw: string | null, fallback: number, min: number, max: number): number | null {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

export function v1Error(error: V1Failure): Response {
  return Response.json(
    { version: V1_API_VERSION, data: null, error: { code: error.code, message: error.message }, meta: null },
    { status: error.status },
  );
}

/**
 * Keep unforeseen route failures inside the v1 contract without logging request
 * details, API keys, or database messages that may contain sensitive values.
 */
export function handleV1(
  fn: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response>;
export function handleV1<TContext>(
  fn: (req: Request, context: TContext) => Promise<Response>,
): (req: Request, context: TContext) => Promise<Response>;
export function handleV1<TContext>(
  fn: (req: Request, context?: TContext) => Promise<Response>,
): (req: Request, context?: TContext) => Promise<Response> {
  return async (req, context) => {
    try {
      return await fn(req, context);
    } catch (error) {
      const name = error instanceof Error ? error.name : typeof error;
      console.error(`[api:v1] unexpected request failure (${name})`);
      return v1Error({
        status: 500,
        code: "INTERNAL_ERROR",
        message: "Something went wrong.",
      });
    }
  };
}

export function v1ListResponse<T>(
  data: T[],
  event: V1EventMeta,
  pagination: V1PaginationMeta,
): Response {
  return Response.json({
    version: V1_API_VERSION,
    data,
    error: null,
    meta: { event, pagination },
  });
}

export function getV1PaginationMeta(
  query: V1ListQuery,
  total: number,
): V1PaginationMeta {
  const hasMore = query.offset + query.limit < total;
  return {
    limit: query.limit,
    offset: query.offset,
    total,
    hasMore,
    nextOffset: hasMore ? query.offset + query.limit : null,
  };
}

/** A single item from an already event-scoped v1 route. */
export function v1ItemResponse<T>(data: T, event: V1EventMeta): Response {
  return Response.json({
    version: V1_API_VERSION,
    data,
    error: null,
    meta: { event },
  });
}
