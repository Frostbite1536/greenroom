/**
 * The v1 contract constants, and nothing else.
 *
 * This module is deliberately PURE: it imports nothing — no environment
 * reader, no auth helper, no Prisma client, no request handling, not even a
 * type from a runtime module. That is what lets the published OpenAPI document
 * (`lib/api/openapi.ts`) state the real bounds without dragging a runtime graph
 * into a route that is served `force-static` and unauthenticated.
 *
 * Three consumers import these numbers, and none of them restates one:
 *
 *   lib/env.ts        -> validates `GREENROOM_API_KEY` against the min length
 *   lib/api/v1.ts     -> enforces the bounds on every request
 *   lib/api/openapi.ts-> publishes the bounds as the contract
 *
 * `lib/api/openapi.test.ts` fails if any of the three grows its own copy of a
 * number, and `lib/api/openapi-purity.test.ts` fails if this module ever gains
 * an import.
 */

/** The envelope's `version` discriminator, and the URL segment it matches. */
export const V1_API_VERSION = "v1";

/** `limit` when the caller omits it. */
export const DEFAULT_V1_LIMIT = 50;

/** Largest accepted `limit`. Bounds the row count a single read can cost. */
export const MAX_V1_LIMIT = 100;

/** Largest accepted `offset`. Bounds how deep a caller may page. */
export const MAX_V1_OFFSET = 1_000_000;

/**
 * Longest accepted `event` selector. A slug or a cuid is far shorter; this is
 * the varchar bound the column itself carries, rejected before any query runs.
 *
 * Declared alongside the pagination bounds because the published OpenAPI
 * document states all four, and the drift test imports them from here rather
 * than restating the numbers.
 */
export const MAX_V1_EVENT_SELECTOR_LENGTH = 191;

/**
 * Shortest `GREENROOM_API_KEY` the server will accept. A shorter value is
 * ignored entirely, exactly as though the variable were unset, rather than
 * authenticating anyone against a guessable secret.
 *
 * Ignoring it does not disable the surface: per-event `ApiCredential` keys are
 * still resolved, and a request no credential accepts is refused with
 * `401 UNAUTHORIZED`. `lib/api/v1.ts` carries the full truth table.
 */
export const V1_API_KEY_MIN_LENGTH = 32;
