/**
 * The published contract for the read-only v1 API, as one static OpenAPI 3.1.1
 * document.
 *
 * This module is the single source for BOTH published surfaces: the machine
 * endpoint at `/api/v1/openapi.json` serves this object verbatim, and the human
 * page at `/docs/api` renders this object rather than restating it in prose.
 * There is no second copy to drift, and `lib/api/openapi.test.ts` fails when
 * this document stops describing what the route files under `app/api/v1` do.
 *
 * Four rules govern what may be written here.
 *
 * 1. **The code is the contract; this document follows it.** Every field name
 *    below is asserted against the real serializer output in
 *    `lib/api/v1-serialize.ts`, every bound against the exported constants in
 *    `lib/api/v1-contract.ts`, and every ordering guarantee against the route's
 *    own `orderBy`. Describe what ships, including the parts that are awkward.
 * 2. **No credential ever appears here.** The deployment-wide
 *    `GREENROOM_API_KEY` is not event-scoped, so publishing it would turn every
 *    event reachable by this API into public data (docs/ROADMAP.md, the standing
 *    constraint above the "Next build queue" list). Examples use
 *    `API_KEY_PLACEHOLDER` and nothing else; this
 *    module reads no environment variable at all, and the drift test proves the
 *    serialized document never contains the configured key.
 * 3. **It stays static.** The document describes a contract, not an event, so
 *    it needs no database read and no key to fetch. That is what makes serving
 *    it unauthenticated safe.
 * 4. **Its import graph stays pure.** The bounds come from the dependency-free
 *    `lib/api/v1-contract` module, never from `lib/api/v1` or `lib/env`, so
 *    nothing this document needs can reach an environment read, an auth helper,
 *    a Prisma client, or request handling. `lib/api/openapi-purity.test.ts`
 *    walks the transitive graph and fails if that ever stops being true.
 */
import {
  DEFAULT_V1_LIMIT,
  MAX_V1_EVENT_SELECTOR_LENGTH,
  MAX_V1_LIMIT,
  MAX_V1_OFFSET,
  MAX_V1_SUBMISSION_ID_LENGTH,
  V1_API_KEY_MIN_LENGTH,
  V1_API_VERSION,
  V1_SUBMISSION_STATUSES,
} from "@/lib/api/v1-contract";

/** Where the machine-readable document is served. Unauthenticated by design. */
export const V1_OPENAPI_PATH = "/api/v1/openapi.json";

/** Where the human-readable rendering of that same document is served. */
export const API_DOCS_PATH = "/docs/api";

/**
 * The only credential-shaped string allowed anywhere in this document or on the
 * docs page. It is deliberately an instruction rather than a plausible key, so
 * a reader who pastes it verbatim gets a 401 instead of thinking it works.
 */
export const API_KEY_PLACEHOLDER = "replace-with-at-least-32-random-characters";

/** The three key-gated list routes, in the order the docs page presents them. */
export const V1_LIST_PATHS = [
  "/api/v1/submissions",
  "/api/v1/speakers",
  "/api/v1/schedule",
] as const;

/** Key-gated item routes, documented separately from paginated list routes. */
export const V1_ITEM_PATHS = ["/api/v1/submissions/{submissionId}"] as const;

const EVENT_EXAMPLE = "forward-2026";

const speakerRefExample = (id: string, name: string, isPrimary: boolean) => ({
  id,
  name,
  email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.test`,
  avatarUrl: null,
  isPrimary,
});

const eventMetaExample = {
  id: "clx0event0000000000000000",
  name: "Forward 2026",
  slug: EVENT_EXAMPLE,
  timezone: "UTC",
};

const paginationExample = {
  limit: DEFAULT_V1_LIMIT,
  offset: 0,
  total: 2,
  hasMore: false,
  nextOffset: null,
};

/** `{ version, data, error, meta }` around a page of one resource. */
function listEnvelope(schemaName: string, description: string, examples: unknown[]) {
  return {
    type: "object",
    description,
    additionalProperties: false,
    required: ["version", "data", "error", "meta"],
    properties: {
      version: { const: V1_API_VERSION, description: "Always the string `v1`." },
      data: { type: "array", items: { $ref: `#/components/schemas/${schemaName}` } },
      error: { type: "null", description: "Always null on a 2xx response." },
      meta: { $ref: "#/components/schemas/ListMeta" },
    },
    examples: [
      { version: V1_API_VERSION, data: examples, error: null, meta: { event: eventMetaExample, pagination: paginationExample } },
    ],
  };
}

function itemEnvelope(schemaName: string, description: string, example: unknown) {
  return {
    type: "object",
    description,
    additionalProperties: false,
    required: ["version", "data", "error", "meta"],
    properties: {
      version: { const: V1_API_VERSION, description: "Always the string `v1`." },
      data: { $ref: `#/components/schemas/${schemaName}` },
      error: { type: "null", description: "Always null on a 2xx response." },
      meta: { $ref: "#/components/schemas/ItemMeta" },
    },
    examples: [{ version: V1_API_VERSION, data: example, error: null, meta: { event: eventMetaExample } }],
  };
}

/** One key-gated list operation. Every one of the three is shaped identically. */
function listOperation(config: {
  operationId: string;
  summary: string;
  description: string;
  tag: string;
  envelope: string;
  ordering: string[];
  parameters?: unknown[];
}) {
  return {
    get: {
      operationId: config.operationId,
      summary: config.summary,
      description: config.description,
      tags: [config.tag],
      // Either scheme alone is sufficient; the route reads Authorization first.
      security: [{ bearerApiKey: [] }, { apiKeyHeader: [] }],
      // Machine-readable form of the ordering sentence in `description`. The
      // drift test parses the route's own `orderBy` and compares it to this.
      "x-ordering": config.ordering,
      parameters: config.parameters ?? [
        { $ref: "#/components/parameters/EventSelector" },
        { $ref: "#/components/parameters/Limit" },
        { $ref: "#/components/parameters/Offset" },
      ],
      responses: {
        "200": {
          description: "A stably ordered page of results for the selected event.",
          content: { "application/json": { schema: { $ref: `#/components/schemas/${config.envelope}` } } },
        },
        "400": { $ref: "#/components/responses/BadRequest" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/EventNotFound" },
        "500": { $ref: "#/components/responses/InternalError" },
      },
    },
  };
}

/** One documented failure, with the exact envelope the route returns. */
function errorResponse(description: string, code: string, message: string) {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ErrorEnvelope" },
        examples: [{ version: V1_API_VERSION, data: null, error: { code, message }, meta: null }],
      },
    },
  };
}

export const OPENAPI_DOCUMENT = {
  openapi: "3.1.1",
  info: {
    title: "Greenroom read-only API",
    version: V1_API_VERSION,
    summary: "Server-to-server reads of one event's proposals, speakers, and published program.",
    description: [
      "Greenroom's `/api/v1/*` surface is read-only, event-scoped, and gated by a server-side",
      "API key. It exists so another system can mirror a conference program; it is not the",
      "application's own API, and it can neither create nor modify anything.",
      "",
      "**Two kinds of key are accepted, and they differ in reach.** The deployment-wide",
      "`GREENROOM_API_KEY` is set by the operator in the server environment and may address any",
      "event on the deployment. A per-event key is issued by an event's organizer from that",
      "event's settings, looks like `grk_<id>_<secret>`, and may address that one event and",
      "nothing else — presenting it with any other `event` selector is refused exactly as an",
      "invalid key is. Either kind is sent the same way, in either header below.",
      "",
      "The `<id>` in the middle of a per-event key is not secret: it is how the server finds",
      "which key you presented, and it is what your event's settings page shows you in the",
      "list. The `<secret>` after it is the part that authenticates, and the server keeps only",
      "a one-way hash of it — nobody, including the organizer who created it, can read a key",
      "back after it is issued.",
      "",
      "**Every request needs a credential, and every request without an accepted one is",
      "`401 UNAUTHORIZED`.** There is no separate \"this server is not configured\" answer: a",
      "deployment can be fully set up with nothing but per-event keys, so a missing or wrong",
      "credential is an authentication failure and is reported as one. A deployment that has",
      `configured neither a \`GREENROOM_API_KEY\` (one shorter than ${V1_API_KEY_MIN_LENGTH} characters is ignored`,
      "entirely, as though unset) nor any per-event key simply refuses every request, because",
      "no credential can be accepted — it still exposes no program data.",
      "",
      "A presented credential is always checked: against the deployment-wide key when one is",
      "set, and against this deployment's issued per-event keys either way. An organizer's",
      "per-event key therefore works whether or not the operator has set a global one.",
      "",
      "Checking the deployment-wide key costs no database read. Checking a per-event key costs",
      "exactly one indexed lookup of the key itself, which reaches no event and no program",
      "data; the event named by `event` is only ever read after a credential has been accepted,",
      "and for a per-event key only ever within that key's own event.",
      "",
      "Every refusal of a credential is the same `401 UNAUTHORIZED`: an unknown key, a revoked",
      "key, and a valid per-event key aimed at somebody else's event are deliberately",
      "indistinguishable, and none of them reveals whether the event named actually exists.",
      "",
      "This document is itself unauthenticated: it describes the contract and contains no",
      "program data and no credential. Every credential in every example below is the literal",
      `placeholder \`${API_KEY_PLACEHOLDER}\` — the deployment-wide key is not event-scoped, so`,
      "publishing it would make every event this API can address public. Ask the deployment's",
      "operator for a real one, or your event's organizer for a per-event one.",
    ].join("\n"),
    license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
  },
  servers: [
    { url: "https://your-app.example", description: "Replace with your own deployment's origin." },
  ],
  tags: [
    { name: "Submissions", description: "Proposals submitted to this event's calls for papers." },
    { name: "Speakers", description: "People reachable through this event's published program." },
    { name: "Schedule", description: "Placed, published sessions with their slot, room, and track." },
    { name: "Meta", description: "The contract itself. No key required." },
  ],
  // A request that carries no accepted credential is refused, so the default is
  // stated at the document level and only the meta endpoint opts out.
  security: [{ bearerApiKey: [] }, { apiKeyHeader: [] }],
  paths: {
    "/api/v1/submissions": listOperation({
      operationId: "listSubmissions",
      summary: "List this event's proposals",
      description: [
        "Every proposal belonging to the selected event, with its form, category, speaker",
        "roster, and the answers given to that form's fields.",
        "",
        "Review data is never part of this payload: assignments, scores, rubric criteria, and",
        "private reviewer comments have no field here and cannot be reached through it.",
        "",
        "Browse reads order by `createdAt`, `id` and may narrow with one lifecycle status.",
      ].join("\n"),
      tag: "Submissions",
      envelope: "SubmissionListEnvelope",
      ordering: ["createdAt", "id"],
      parameters: [
        { $ref: "#/components/parameters/EventSelector" },
        { $ref: "#/components/parameters/Limit" },
        { $ref: "#/components/parameters/Offset" },
        { $ref: "#/components/parameters/SubmissionStatus" },
      ],
    }),
    "/api/v1/submissions/{submissionId}": {
      get: {
        operationId: "getSubmission",
        summary: "Get one event-scoped proposal",
        description: [
          "Returns exactly the proposal projection used by the submissions list.",
          "Review assignments, scores, rubric criteria, and private reviewer comments are excluded.",
          "The authenticated event predicate is applied to the id lookup; a missing or cross-event id",
          "returns the same `404 SUBMISSION_NOT_FOUND`.",
        ].join("\n"),
        tags: ["Submissions"],
        security: [{ bearerApiKey: [] }, { apiKeyHeader: [] }],
        parameters: [
          { $ref: "#/components/parameters/EventSelector" },
          { $ref: "#/components/parameters/SubmissionId" },
        ],
        responses: {
          "200": {
            description: "The proposal for the selected event.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/SubmissionItemEnvelope" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/SubmissionNotFound" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },
    "/api/v1/speakers": listOperation({
      operationId: "listSpeakers",
      summary: "List this event's speakers",
      description: [
        "People reached only through this event's own abstract or session speaker relations —",
        "the global user table and event memberships are not a source here, so an organizer or",
        "an evaluator never appears as a speaker.",
        "",
        "A held-back talk does not announce its speaker. A session qualifies its speakers only",
        "while it is published, and a proposal qualifies its speakers only when it has no linked",
        "session yet or that session is published. `appearances` counts the same event-local,",
        "publication-filtered relations, so it never hints at a withheld talk.",
        "",
        "Ordered by `name` ascending with `id` ascending as the tiebreaker.",
      ].join("\n"),
      tag: "Speakers",
      envelope: "SpeakerListEnvelope",
      ordering: ["name", "id"],
    }),
    "/api/v1/schedule": listOperation({
      operationId: "listSchedule",
      summary: "List this event's published, placed sessions",
      description: [
        "One entry per placement: a slot with its room, optional track, and the session that",
        "sits in it. Because the record read is the placement itself, backlog and unplaced",
        "sessions cannot appear.",
        "",
        "Only published sessions are returned. The same filter feeds the page and the total, so",
        "`meta.pagination.total` never advertises rows the page will not hand back.",
        "",
        "Ordered by `startsAt` ascending with `id` ascending as the tiebreaker.",
      ].join("\n"),
      tag: "Schedule",
      envelope: "ScheduleListEnvelope",
      ordering: ["startsAt", "id"],
    }),
    [V1_OPENAPI_PATH]: {
      get: {
        operationId: "getOpenApiDocument",
        summary: "This document",
        description: [
          "Returns this OpenAPI 3.1.1 document as JSON.",
          "",
          "Deliberately unauthenticated, and the one route on this surface that is. It performs",
          "no database read and returns no program data, so requiring the key would only make",
          "the contract unreadable to the integrator deciding whether to ask for one.",
        ].join("\n"),
        tags: ["Meta"],
        // Explicitly empty: this overrides the document-level requirement.
        security: [],
        responses: {
          "200": {
            description: "The OpenAPI document describing this API.",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerApiKey: {
        type: "http",
        scheme: "bearer",
        description: [
          `\`Authorization: Bearer ${API_KEY_PLACEHOLDER}\``,
          "",
          "Carries either accepted key: the deployment-wide `GREENROOM_API_KEY`, or an event's",
          "own `grk_<id>_<secret>` key, which reaches only that event.",
          "",
          "Checked first: when both headers are sent, a malformed `Authorization` value is a",
          "failure rather than something an unrelated `X-API-Key` can bypass.",
        ].join("\n"),
      },
      apiKeyHeader: {
        type: "apiKey",
        in: "header",
        name: "X-API-Key",
        description: [
          `\`X-API-Key: ${API_KEY_PLACEHOLDER}\``,
          "",
          "Carries either accepted key, exactly as the Bearer scheme does.",
          "",
          "Read only when no `Authorization` header is present.",
        ].join("\n"),
      },
    },
    parameters: {
      EventSelector: {
        name: "event",
        in: "query",
        required: true,
        description: [
          "The event's slug or id. Required on every request — this API has no implicit",
          "current event and never spans events.",
          "",
          "With the deployment-wide key, an unknown value is `404 EVENT_NOT_FOUND`. With a",
          "per-event key, anything other than that key's own event is `401 UNAUTHORIZED`,",
          "whether or not such an event exists: a per-event key cannot be used to discover",
          "which other events this deployment hosts.",
        ].join("\n"),
        schema: { type: "string", minLength: 1, maxLength: MAX_V1_EVENT_SELECTOR_LENGTH },
        example: EVENT_EXAMPLE,
      },
      Limit: {
        name: "limit",
        in: "query",
        required: false,
        description: `Rows per page. Must be a whole number from 1 to ${MAX_V1_LIMIT}; anything else is \`400 INVALID_QUERY\`.`,
        schema: { type: "integer", minimum: 1, maximum: MAX_V1_LIMIT, default: DEFAULT_V1_LIMIT },
      },
      Offset: {
        name: "offset",
        in: "query",
        required: false,
        description: `Rows to skip. Must be a whole number from 0 to ${MAX_V1_OFFSET}; anything else is \`400 INVALID_QUERY\`.`,
        schema: { type: "integer", minimum: 0, maximum: MAX_V1_OFFSET, default: 0 },
      },
      SubmissionStatus: {
        name: "status",
        in: "query",
        required: false,
        description: "One exact lifecycle status that narrows the existing event-scoped submissions browse read.",
        schema: { type: "string", enum: V1_SUBMISSION_STATUSES },
      },
      SubmissionId: {
        name: "submissionId",
        in: "path",
        required: true,
        description: "Proposal id. It is matched with the selected, authenticated event, so another event's id is indistinguishable from a missing one.",
        schema: { type: "string", minLength: 1, maxLength: MAX_V1_SUBMISSION_ID_LENGTH },
      },
    },
    responses: {
      BadRequest: errorResponse(
        "The query is missing `event` (`EVENT_REQUIRED`) or a parameter is out of bounds (`INVALID_QUERY`).",
        "EVENT_REQUIRED",
        "Query parameter 'event' is required.",
      ),
      Unauthorized: errorResponse(
        "The only authentication failure this surface reports. One refusal covers every cause: no key sent at all, a value that is not shaped like a key, a key matching neither the deployment-wide key nor any issued per-event key, a per-event key that has been revoked, and a valid per-event key used against an event other than its own. It is also the answer when this deployment has configured no credential of either kind — the surface is reachable, so it authenticates rather than claiming to be unconfigured. Both comparisons are constant-time over fixed-size hashes, so a failure discloses neither the secret's length nor how much of it was right — and never whether the event named exists.",
        "UNAUTHORIZED",
        "A valid API key is required.",
      ),
      EventNotFound: errorResponse(
        "No event has that slug or id. Returned after authentication, so it is not an unauthenticated probe for which events exist.",
        "EVENT_NOT_FOUND",
        "Event not found.",
      ),
      SubmissionNotFound: errorResponse(
        "No proposal with that id belongs to the selected event. This also covers a cross-event id.",
        "SUBMISSION_NOT_FOUND",
        "Submission not found.",
      ),
      InternalError: errorResponse(
        "An unexpected failure, reported inside this envelope. The message is fixed: database text and request details are never returned to a caller.",
        "INTERNAL_ERROR",
        "Something went wrong.",
      ),
    },
    schemas: {
      ErrorEnvelope: {
        type: "object",
        description: "Every failure on this surface, in the same four top-level fields as a success.",
        additionalProperties: false,
        required: ["version", "data", "error", "meta"],
        properties: {
          version: { const: V1_API_VERSION },
          data: { type: "null" },
          error: { $ref: "#/components/schemas/ErrorBody" },
          meta: { type: "null" },
        },
      },
      ErrorBody: {
        type: "object",
        description: "A stable machine code and a message safe to show a human.",
        additionalProperties: false,
        required: ["code", "message"],
        properties: {
          code: {
            type: "string",
            enum: [
              "EVENT_REQUIRED",
              "INVALID_QUERY",
              "UNAUTHORIZED",
              "EVENT_NOT_FOUND",
              "SUBMISSION_NOT_FOUND",
              "INTERNAL_ERROR",
            ],
          },
          message: { type: "string" },
        },
      },
      ListMeta: {
        type: "object",
        additionalProperties: false,
        required: ["event", "pagination"],
        properties: {
          event: { $ref: "#/components/schemas/EventMeta" },
          pagination: { $ref: "#/components/schemas/Pagination" },
        },
      },
      ItemMeta: {
        type: "object",
        additionalProperties: false,
        required: ["event"],
        properties: {
          event: { $ref: "#/components/schemas/EventMeta" },
        },
      },
      EventMeta: {
        type: "object",
        description: "The event the request resolved to, echoed so a caller can confirm the selector.",
        additionalProperties: false,
        required: ["id", "name", "slug", "timezone"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          slug: { type: "string" },
          timezone: { type: "string", description: "IANA timezone name. Timestamps in `data` are UTC ISO-8601 regardless." },
        },
        examples: [eventMetaExample],
      },
      Pagination: {
        type: "object",
        description: "Offset pagination. `total` counts every row matching the same filter as the page.",
        additionalProperties: false,
        required: ["limit", "offset", "total", "hasMore", "nextOffset"],
        properties: {
          limit: { type: "integer", minimum: 1, maximum: MAX_V1_LIMIT },
          offset: { type: "integer", minimum: 0, maximum: MAX_V1_OFFSET },
          total: { type: "integer", minimum: 0 },
          hasMore: { type: "boolean", description: "True when `offset + limit` is below `total`." },
          nextOffset: {
            type: ["integer", "null"],
            description: "The `offset` to request next, or null on the last page.",
          },
        },
        examples: [paginationExample],
      },
      SpeakerRef: {
        type: "object",
        description: "A person on a proposal's or a session's roster. Primary speakers sort first.",
        additionalProperties: false,
        required: ["id", "name", "email", "avatarUrl", "isPrimary"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          email: { type: "string", format: "email" },
          avatarUrl: { type: ["string", "null"] },
          isPrimary: { type: "boolean" },
        },
        examples: [speakerRefExample("clx0user00000000000000001", "Ada Lovelace", true)],
      },
      Submission: {
        type: "object",
        description: "One proposal. Carries no review, score, or reviewer-comment field.",
        additionalProperties: false,
        required: [
          "id", "title", "description", "format", "durationMinutes", "status",
          "submittedAt", "createdAt", "updatedAt", "form", "category", "speakers", "answers",
        ],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          description: { type: ["string", "null"], description: "The proposal's abstract body." },
          format: { type: ["string", "null"] },
          durationMinutes: { type: ["integer", "null"] },
          status: {
            type: "string",
            description: "Lifecycle status, e.g. `DRAFT`, `SUBMITTED`, `UNDER_REVIEW`, `ACCEPTED`, `REJECTED`, `WITHDRAWN`.",
          },
          submittedAt: { type: ["string", "null"], format: "date-time", description: "Null while the proposal is still a draft." },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          form: { $ref: "#/components/schemas/SubmissionForm" },
          category: {
            oneOf: [{ $ref: "#/components/schemas/SubmissionCategory" }, { type: "null" }],
          },
          speakers: { type: "array", items: { $ref: "#/components/schemas/SpeakerRef" } },
          answers: {
            type: "object",
            description: "Answers keyed by form-field key. Values are whatever that field type stores, so this map is intentionally open.",
            additionalProperties: true,
            examples: [{ "audience-level": "intermediate", "needs-av": true }],
          },
        },
      },
      SubmissionForm: {
        type: "object",
        description: "The call for papers this proposal was submitted to.",
        additionalProperties: false,
        required: ["id", "name", "slug"],
        properties: { id: { type: "string" }, name: { type: "string" }, slug: { type: "string" } },
      },
      SubmissionCategory: {
        type: "object",
        description: "The event-owned category chosen on the proposal. Null when none was chosen.",
        additionalProperties: false,
        required: ["id", "name"],
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
      Speaker: {
        type: "object",
        description: "A person on this event's published program, with event-local appearance counts.",
        additionalProperties: false,
        required: ["id", "name", "email", "avatarUrl", "profile", "appearances"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          email: { type: "string", format: "email" },
          avatarUrl: { type: ["string", "null"] },
          profile: {
            oneOf: [{ $ref: "#/components/schemas/SpeakerProfile" }, { type: "null" }],
            description: "Null when the person has never filled in a speaker profile.",
          },
          appearances: { $ref: "#/components/schemas/SpeakerAppearances" },
        },
      },
      SpeakerProfile: {
        type: "object",
        description: "The person's one global profile. `slideDeckUrl` is not per-event today.",
        additionalProperties: false,
        required: ["bio", "company", "jobTitle", "headshotUrl", "slideDeckUrl", "socialLinks"],
        properties: {
          bio: { type: ["string", "null"] },
          company: { type: ["string", "null"] },
          jobTitle: { type: ["string", "null"] },
          headshotUrl: { type: ["string", "null"] },
          slideDeckUrl: { type: ["string", "null"] },
          socialLinks: {
            description: "Free-form, author-supplied link map, or null. Treat every value as untrusted text.",
            additionalProperties: true,
            examples: [{ mastodon: "https://example.test/@ada" }],
          },
        },
      },
      SpeakerAppearances: {
        type: "object",
        description: "Counts within this event only, under the same publication filter as the list itself.",
        additionalProperties: false,
        required: ["submissions", "sessions"],
        properties: {
          submissions: { type: "integer", minimum: 0 },
          sessions: { type: "integer", minimum: 0 },
        },
      },
      ScheduleSlot: {
        type: "object",
        description: "A placement: when and where, plus the published session that sits there.",
        additionalProperties: false,
        required: ["id", "startsAt", "endsAt", "room", "track", "session"],
        properties: {
          id: { type: "string", description: "The slot's id, not the session's." },
          startsAt: { type: "string", format: "date-time" },
          endsAt: { type: "string", format: "date-time" },
          room: { $ref: "#/components/schemas/Room" },
          track: { oneOf: [{ $ref: "#/components/schemas/Track" }, { type: "null" }] },
          session: { $ref: "#/components/schemas/Session" },
        },
      },
      Room: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "capacity"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          capacity: { type: ["integer", "null"] },
        },
      },
      Track: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "color"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          color: { type: "string", description: "CSS colour string as the organizer set it." },
        },
      },
      Session: {
        type: "object",
        description: "The published talk in this slot.",
        additionalProperties: false,
        required: ["id", "title", "description", "format", "durationMinutes", "speakers"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          description: { type: ["string", "null"] },
          format: { type: ["string", "null"] },
          durationMinutes: { type: "integer" },
          speakers: { type: "array", items: { $ref: "#/components/schemas/SpeakerRef" } },
        },
      },
      SubmissionListEnvelope: listEnvelope("Submission", "A page of proposals.", [
        {
          id: "clx0abstract00000000000001",
          title: "Scheduling a conference without losing a room",
          description: "What placement conflicts actually cost, and how to see them early.",
          format: "TALK",
          durationMinutes: 30,
          status: "ACCEPTED",
          submittedAt: "2026-01-14T09:12:00.000Z",
          createdAt: "2026-01-12T17:40:00.000Z",
          updatedAt: "2026-02-02T11:05:00.000Z",
          form: { id: "clx0form00000000000000001", name: "Call for speakers", slug: "call-for-speakers" },
          category: { id: "clx0cat000000000000000001", name: "Operations" },
          speakers: [speakerRefExample("clx0user00000000000000001", "Ada Lovelace", true)],
          answers: { "audience-level": "intermediate", "needs-av": true },
        },
      ]),
      SubmissionItemEnvelope: itemEnvelope("Submission", "One event-scoped proposal.", {
        id: "clx0abstract00000000000001",
        title: "Scheduling a conference without losing a room",
        description: "What placement conflicts actually cost, and how to see them early.",
        format: "TALK",
        durationMinutes: 30,
        status: "ACCEPTED",
        submittedAt: "2026-01-14T09:12:00.000Z",
        createdAt: "2026-01-12T17:40:00.000Z",
        updatedAt: "2026-02-02T11:05:00.000Z",
        form: { id: "clx0form00000000000000001", name: "Call for speakers", slug: "call-for-speakers" },
        category: { id: "clx0cat000000000000000001", name: "Operations" },
        speakers: [speakerRefExample("clx0user00000000000000001", "Ada Lovelace", true)],
        answers: { "audience-level": "intermediate", "needs-av": true },
      }),
      SpeakerListEnvelope: listEnvelope("Speaker", "A page of speakers.", [
        {
          id: "clx0user00000000000000001",
          name: "Ada Lovelace",
          email: "ada.lovelace@example.test",
          avatarUrl: null,
          profile: {
            bio: "Works on program operations.",
            company: "Analytical Engines",
            jobTitle: "Principal Engineer",
            headshotUrl: null,
            slideDeckUrl: null,
            socialLinks: { mastodon: "https://example.test/@ada" },
          },
          appearances: { submissions: 1, sessions: 1 },
        },
      ]),
      ScheduleListEnvelope: listEnvelope("ScheduleSlot", "A page of placements.", [
        {
          id: "clx0slot00000000000000001",
          startsAt: "2026-05-14T09:00:00.000Z",
          endsAt: "2026-05-14T09:30:00.000Z",
          room: { id: "clx0room00000000000000001", name: "Main Hall", capacity: 400 },
          track: { id: "clx0track0000000000000001", name: "Operations", color: "#167565" },
          session: {
            id: "clx0session000000000000001",
            title: "Scheduling a conference without losing a room",
            description: "What placement conflicts actually cost, and how to see them early.",
            format: "TALK",
            durationMinutes: 30,
            speakers: [speakerRefExample("clx0user00000000000000001", "Ada Lovelace", true)],
          },
        },
      ]),
    },
  },
};

/**
 * The curl lines the docs page prints. Written here rather than in the page so
 * the placeholder rule has one place to hold, and so the drift test can check
 * the same strings the reader copies.
 */
export const CURL_EXAMPLES = [
  {
    title: "Set your deployment and key",
    // A shell variable, so nothing that looks like a credential is ever pasted
    // into a command a reader might share verbatim.
    lines: [
      'export BASE_URL="https://your-app.example"',
      `export GREENROOM_API_KEY="${API_KEY_PLACEHOLDER}"`,
    ],
  },
  {
    title: "List proposals (Bearer)",
    lines: [
      'curl -H "Authorization: Bearer $GREENROOM_API_KEY" \\',
      `  "$BASE_URL/api/v1/submissions?event=${EVENT_EXAMPLE}&limit=${DEFAULT_V1_LIMIT}&offset=0"`,
    ],
  },
  {
    title: "List speakers (X-API-Key)",
    lines: [
      'curl -H "X-API-Key: $GREENROOM_API_KEY" \\',
      `  "$BASE_URL/api/v1/speakers?event=${EVENT_EXAMPLE}"`,
    ],
  },
  {
    title: "Read this contract (no key)",
    lines: [`curl "$BASE_URL${V1_OPENAPI_PATH}"`],
  },
];

/**
 * The workflow-to-route framing from docs/judging/WORKFLOW-ROUTES.md, condensed
 * to the integration question each surface answers. The point is that most
 * "can I get X out of Greenroom" questions are already answered by a public
 * page, and the key-gated API is for the cases that are not.
 */
export const INTEGRATION_SURFACES = [
  {
    need: "Mirror the proposal pipeline into another system",
    route: "/api/v1/submissions",
    keyed: true,
    note: "The only surface that returns proposals. Review data is excluded by construction.",
  },
  {
    need: "Publish the speaker lineup on your own site",
    route: "/api/v1/speakers",
    keyed: true,
    note: "Prefer /speakers or /embed/speakers if a rendered page will do — neither needs a key.",
  },
  {
    need: "Sync the published program into another app",
    route: "/api/v1/schedule",
    keyed: true,
    note: "Placed and published sessions only. /api/comms/calendar exports the same program as .ics.",
  },
  {
    need: "Show the program to visitors",
    route: "/schedule and /speakers",
    keyed: false,
    note: "The canonical public pages. /embed/schedule and /embed/speakers are the same, chrome-free, for an iframe.",
  },
  {
    need: "Read this contract before asking for a key",
    route: V1_OPENAPI_PATH,
    keyed: false,
    note: "This document, as JSON. No key, no database read, no program data.",
  },
];
