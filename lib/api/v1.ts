import { createHash, timingSafeEqual } from "node:crypto";
import { getV1ApiKey } from "@/lib/env";

export const V1_API_VERSION = "v1";
export const DEFAULT_V1_LIMIT = 50;
export const MAX_V1_LIMIT = 100;
export const MAX_V1_OFFSET = 1_000_000;
/**
 * Longest accepted `event` selector. A slug or a cuid is far shorter; this is
 * the varchar bound the column itself carries, rejected before any query runs.
 *
 * Exported alongside the pagination bounds because the published OpenAPI
 * document states all four, and the drift test imports them from here rather
 * than restating the numbers.
 */
export const MAX_V1_EVENT_SELECTOR_LENGTH = 191;

export type V1ListQuery = {
  event: string;
  limit: number;
  offset: number;
};

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
 * Authenticates before any database work. An unconfigured key intentionally
 * reports 503 so operators can distinguish a disabled API from bad client
 * credentials.
 */
export function authorizeV1Request(
  headers: Headers,
  configuredKey = getV1ApiKey(),
): { ok: true } | { ok: false; error: V1Failure } {
  if (!configuredKey) {
    return {
      ok: false,
      error: {
        status: 503,
        code: "API_KEY_NOT_CONFIGURED",
        message: "The v1 API is not configured on this server.",
      },
    };
  }

  const requestKey = getV1RequestKey(headers);
  if (!requestKey || !keysMatch(configuredKey, requestKey)) {
    return {
      ok: false,
      error: { status: 401, code: "UNAUTHORIZED", message: "A valid API key is required." },
    };
  }

  return { ok: true };
}

/** Parses the shared required event selector and bounded offset pagination. */
export function parseV1ListQuery(searchParams: URLSearchParams):
  | { ok: true; value: V1ListQuery }
  | { ok: false; error: V1Failure } {
  const event = searchParams.get("event")?.trim();
  if (!event) {
    return {
      ok: false,
      error: { status: 400, code: "EVENT_REQUIRED", message: "Query parameter 'event' is required." },
    };
  }
  if (event.length > MAX_V1_EVENT_SELECTOR_LENGTH) {
    return {
      ok: false,
      error: { status: 400, code: "INVALID_QUERY", message: "Query parameter 'event' is too long." },
    };
  }

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

  return { ok: true, value: { event, limit, offset } };
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
): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      return await fn(req);
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
