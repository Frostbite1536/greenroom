import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  API_KEY_PLACEHOLDER,
  CURL_EXAMPLES,
  OPENAPI_DOCUMENT,
  V1_ITEM_PATHS,
  V1_LIST_PATHS,
  V1_OPENAPI_PATH,
} from "@/lib/api/openapi";
import { endpointViews, listEndpointViews, resolveRef } from "@/lib/api/openapi-view";
import {
  DEFAULT_V1_LIMIT,
  MAX_V1_EVENT_SELECTOR_LENGTH,
  MAX_V1_LIMIT,
  MAX_V1_OFFSET,
  MAX_V1_SUBMISSION_ID_LENGTH,
  V1_API_VERSION,
  getV1PaginationMeta,
  v1Error,
  v1ItemResponse,
  v1ListResponse,
} from "@/lib/api/v1";
import {
  serializeV1ScheduleSlot,
  serializeV1Speaker,
  serializeV1Submission,
} from "@/lib/api/v1-serialize";

/**
 * The contract-drift rail for the published OpenAPI document
 * (docs/ROADMAP.md, "Integration and completeness").
 *
 * A published spec is worse than no spec once it stops being true, and nothing
 * about serving a static JSON file makes it notice that a route changed. So
 * every claim the document makes is checked here against the thing that makes
 * it true:
 *
 *   response fields  -> the real output of lib/api/v1-serialize.ts
 *   envelope         -> the real output of v1ListResponse / v1Error
 *   pagination bounds-> the exported constants in lib/api/v1.ts (imported, not retyped)
 *   query parameters -> the keys parseV1ListQuery actually reads
 *   ordering         -> each route's own `orderBy`
 *   error codes      -> every `code:` / `status:` literal the surface can emit
 *   auth             -> which routes call authorizeV1Request
 *
 * And the hard rule from the roadmap: the document must never carry the real
 * `GREENROOM_API_KEY`. The last block below is that rail.
 *
 * Source assertions are CRLF-safe: no pattern crosses a line break.
 */

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const exists = (path: string) => existsSync(new URL(`../../${path}`, import.meta.url));

/** Comment text stripped, so "this file never does X" is asserted against code. */
const code = (path: string) =>
  read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\r\n]*/g, "$1");

const V1_LIB = "lib/api/v1.ts";
const V1_CONTRACT_LIB = "lib/api/v1-contract.ts";
const V1_SUBMISSION_QUERY_LIB = "lib/api/v1-submission-query.ts";
const V1_KEYED_PATHS = [...V1_LIST_PATHS, ...V1_ITEM_PATHS];
const ROUTE_FILE = (path: string) => `app${path.replace(/\{(\w+)\}/g, "[$1]")}/route.ts`;

function physicalV1Routes(
  directory = new URL("../../app/api/v1/", import.meta.url),
  segments: string[] = [],
): string[] {
  const routes: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nextSegments = [...segments, entry.name];
    const child = new URL(`${entry.name}/`, directory);
    if (existsSync(new URL("route.ts", child))) {
      routes.push(`/api/v1/${nextSegments.map((part) => part.replace(/^\[(\w+)\]$/, "{$1}")).join("/")}`);
    }
    routes.push(...physicalV1Routes(child, nextSegments));
  }
  return routes.sort();
}

/** The four shared bounds the document states and the parser enforces. */
const BOUND_CONSTANTS = [
  "DEFAULT_V1_LIMIT", "MAX_V1_LIMIT", "MAX_V1_OFFSET", "MAX_V1_EVENT_SELECTOR_LENGTH", "MAX_V1_SUBMISSION_ID_LENGTH",
] as const;

type JsonRecord = Record<string, unknown>;
const document = JSON.parse(JSON.stringify(OPENAPI_DOCUMENT)) as JsonRecord;
const paths = document.paths as JsonRecord;
const components = document.components as JsonRecord;
const schemas = components.schemas as JsonRecord;

/** The `get` operation for a documented path. */
function operation(path: string): JsonRecord {
  const item = paths[path] as JsonRecord | undefined;
  assert.ok(item, `${path} is not documented`);
  return item.get as JsonRecord;
}

// ---------------------------------------------------------------------------
// Paths exist, and nothing on the surface is undocumented
// ---------------------------------------------------------------------------

test("every documented path is a route that exists in this repository", () => {
  const documented = Object.keys(paths);
  assert.ok(documented.length > 0, "the document must describe at least one path");
  for (const path of documented) {
    assert.ok(exists(ROUTE_FILE(path)), `${path} is documented but ${ROUTE_FILE(path)} does not exist`);
  }
});

test("every v1 route that exists is documented", () => {
  const routes = physicalV1Routes();

  // Non-vacuity: the three key-gated lists plus the document endpoint.
  assert.ok(routes.length >= 4, `expected the whole v1 surface, found ${routes.join(", ")}`);
  assert.deepEqual(routes, Object.keys(paths).sort(), "physical and documented v1 route inventories differ");
  for (const path of V1_LIST_PATHS) assert.ok(routes.includes(path));
  assert.ok(routes.includes(V1_OPENAPI_PATH));
});

// ---------------------------------------------------------------------------
// Query parameters and their bounds
// ---------------------------------------------------------------------------

test("the documented query parameters are the ones the query parser reads", () => {
  const parsed = new Set([...read(V1_LIB).matchAll(/searchParams\.get\("(\w+)"\)/g)].map(([, key]) => key));
  assert.deepEqual([...parsed].sort(), ["event", "limit", "offset"], "the parser's inputs changed");

  for (const path of V1_LIST_PATHS) {
    const names = (operation(path).parameters as JsonRecord[]).map((raw) => String(resolveRef(raw).name));
    const expected = path === "/api/v1/submissions" ? [...parsed, "status"] : [...parsed];
    assert.deepEqual([...names].sort(), expected.sort(), `${path} documents the wrong parameters`);
  }
  const submissionInputs = new Set([...read(V1_SUBMISSION_QUERY_LIB).matchAll(/searchParams\.get\("(\w+)"\)/g)].map(([, key]) => key));
  assert.deepEqual([...submissionInputs], ["status"], "the submissions parser must remain a bounded status filter");
  const itemNames = (operation(V1_ITEM_PATHS[0]).parameters as JsonRecord[]).map((raw) => String(resolveRef(raw).name));
  assert.deepEqual(itemNames.sort(), ["event", "submissionId"], "the item route documents its exact inputs");
});

test("the documented pagination bounds are the exported constants, not copies", () => {
  const parameters = components.parameters as JsonRecord;
  const schemaOf = (name: string) => (parameters[name] as JsonRecord).schema as JsonRecord;

  assert.equal(schemaOf("Limit").minimum, 1);
  assert.equal(schemaOf("Limit").maximum, MAX_V1_LIMIT);
  assert.equal(schemaOf("Limit").default, DEFAULT_V1_LIMIT);
  assert.equal(schemaOf("Offset").minimum, 0);
  assert.equal(schemaOf("Offset").maximum, MAX_V1_OFFSET);
  assert.equal(schemaOf("Offset").default, 0);
  assert.equal(schemaOf("EventSelector").maxLength, MAX_V1_EVENT_SELECTOR_LENGTH);
  assert.equal((parameters.EventSelector as JsonRecord).required, true, "`event` is required on every v1 read");
  assert.equal(schemaOf("SubmissionId").maxLength, MAX_V1_SUBMISSION_ID_LENGTH);

  // The reported pagination is bounded by the same numbers it accepts.
  const pagination = (schemas.Pagination as JsonRecord).properties as JsonRecord;
  assert.equal((pagination.limit as JsonRecord).maximum, MAX_V1_LIMIT);
  assert.equal((pagination.offset as JsonRecord).maximum, MAX_V1_OFFSET);

  // Imported rather than restated: a future edit that hard-codes 100 here has
  // to delete this import to do it, which is the moment a reviewer sees it.
  const spec = read("lib/api/openapi.ts");
  for (const constant of BOUND_CONSTANTS) {
    assert.match(spec, new RegExp(`^\\s*${constant},$`, "m"), `openapi.ts must import ${constant}`);
  }
  // ...and imported from the PURE module, not from the runtime one. Reading
  // them out of `lib/api/v1` would drag `lib/env` into the static contract
  // route's graph, which is what lib/api/openapi-purity.test.ts forbids.
  assert.match(spec, /^\} from "@\/lib\/api\/v1-contract";$/m, "the spec must read its bounds from the pure module");
  assert.doesNotMatch(spec, /from "@\/lib\/api\/v1"/, "the spec must not import the runtime v1 module");
  assert.doesNotMatch(spec, /from "@\/lib\/env"/, "the spec must not import the environment reader");
});

test("each contract number is defined once, in the pure module", () => {
  const pure = read(V1_CONTRACT_LIB);
  const runtime = read(V1_LIB);
  const env = read("lib/env.ts");

  for (const constant of [...BOUND_CONSTANTS, "V1_API_VERSION", "V1_API_KEY_MIN_LENGTH"]) {
    const declaration = new RegExp(`^export const ${constant} = `, "m");
    assert.match(pure, declaration, `${V1_CONTRACT_LIB} must declare ${constant}`);
    // A second declaration anywhere else is a copy that can drift silently.
    assert.doesNotMatch(runtime, declaration, `${V1_LIB} must re-export ${constant}, not redeclare it`);
    assert.doesNotMatch(env, declaration, `lib/env.ts must re-export ${constant}, not redeclare it`);
  }
  // Both runtime consumers reach the same declarations.
  assert.match(runtime, /from "@\/lib\/api\/v1-contract";$/m, `${V1_LIB} must import the pure module`);
  assert.match(env, /from "@\/lib\/api\/v1-contract";$/m, "lib/env.ts must import the pure module");
});

test("the published path and document version are the accepted ones", () => {
  // The release contract: the `.json` URL and OAS 3.1.1. Pinned as literals on
  // purpose — a constant compared against itself would assert nothing.
  assert.equal(V1_OPENAPI_PATH, "/api/v1/openapi.json");
  assert.equal(document.openapi, "3.1.1");
  assert.ok(V1_OPENAPI_PATH in paths, "the accepted path must be the documented one");
  assert.ok(exists(ROUTE_FILE(V1_OPENAPI_PATH)), `${ROUTE_FILE(V1_OPENAPI_PATH)} must be the served route`);

  // The superseded extensionless path must not come back as a second contract
  // URL: two URLs for one document is exactly the drift this rail exists for.
  assert.equal(exists("app/api/v1/openapi/route.ts"), false, "the superseded /api/v1/openapi route must stay removed");

  // Every published surface names the same URL and version.
  for (const [file, needles] of [
    ["docs/API.md", ["/api/v1/openapi.json", "OpenAPI 3.1.1"]],
    ["docs/judging/WORKFLOW-ROUTES.md", ["/api/v1/openapi.json"]],
  ] as const) {
    for (const needle of needles) {
      assert.ok(read(file).includes(needle), `${file} must document ${needle}`);
    }
    assert.doesNotMatch(read(file), /`\/api\/v1\/openapi`/, `${file} must not name the superseded path`);
  }
});

// ---------------------------------------------------------------------------
// Response shapes, checked against the real serializers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-05-14T09:00:00.000Z");

/** Fully populated on purpose: every nullable relation is present, so the walk reaches every documented sub-schema. */
const SERIALIZED = {
  Submission: serializeV1Submission({
    id: "abstract-1", title: "Proposal", abstract: "Body", format: "TALK", durationMinutes: 30,
    status: "ACCEPTED", submittedAt: NOW, createdAt: NOW, updatedAt: NOW,
    formConfig: { id: "form-1", name: "CFP", slug: "cfp" },
    category: { id: "category-1", name: "Operations" },
    speakers: [{ isPrimary: true, user: { id: "user-1", name: "Ada", email: "ada@example.test", avatarUrl: null } }],
    answers: [{ formField: { key: "audience-level" }, value: "intermediate" }],
  }),
  Speaker: serializeV1Speaker({
    id: "user-1", name: "Ada", email: "ada@example.test", avatarUrl: null,
    speakerProfile: {
      bio: "Bio", company: "Analytical Engines", jobTitle: "Engineer",
      headshotUrl: null, slideDeckUrl: null, socialLinks: { mastodon: "https://example.test/@ada" },
    },
    appearances: { submissions: 1, sessions: 1 },
  }),
  ScheduleSlot: serializeV1ScheduleSlot({
    id: "slot-1", startsAt: NOW, endsAt: new Date("2026-05-14T09:30:00.000Z"),
    room: { id: "room-1", name: "Main Hall", capacity: 400 },
    track: { id: "track-1", name: "Operations", color: "#167565" },
    session: {
      id: "session-1", title: "Session", description: "Body", format: "TALK", durationMinutes: 30,
      speakers: [{ isPrimary: true, user: { id: "user-1", name: "Ada", email: "ada@example.test", avatarUrl: null } }],
    },
  }),
};

/** Schemas that are deliberately open maps: caller-authored keys, no fixed fields. */
function isFreeFormMap(schema: JsonRecord): boolean {
  return schema.additionalProperties === true && schema.properties === undefined;
}

/** Counts the object comparisons a walk made, so a walk that checks nothing fails. */
let comparisons = 0;

/**
 * Asserts a real value and a schema agree on field names AND optionality:
 * every key present, every key `required`, and no key the schema does not name.
 */
function walk(value: unknown, rawSchema: unknown, where: string): void {
  const schema = resolveRef(rawSchema) as JsonRecord;

  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf as JsonRecord[];
    const nullBranch = branches.find((branch) => branch.type === "null");
    assert.ok(nullBranch, `${where}: a oneOf here must offer the null branch the serializer can return`);
    if (value === null) return;
    const objectBranch = branches.find((branch) => branch.type !== "null");
    return walk(value, objectBranch, where);
  }

  if (value === null || typeof value !== "object") return;

  if (Array.isArray(value)) {
    const type = schema.type;
    assert.ok(
      type === "array" || (Array.isArray(type) && type.includes("array")),
      `${where}: the serializer returns an array here`,
    );
    assert.ok(value.length > 0, `${where}: the fixture must populate this array to check its items`);
    return walk(value[0], schema.items, `${where}[0]`);
  }

  if (isFreeFormMap(schema)) return;

  const properties = schema.properties as JsonRecord | undefined;
  assert.ok(properties, `${where}: this object has no documented properties`);

  const actual = Object.keys(value as JsonRecord).sort();
  assert.deepEqual(Object.keys(properties).sort(), actual, `${where}: documented fields differ from the real payload`);
  // Every one of these serializers emits every key on every row, so anything
  // the document leaves out of `required` would be a lie about optionality.
  assert.deepEqual([...((schema.required ?? []) as string[])].sort(), actual, `${where}: \`required\` must list every field`);
  comparisons += 1;

  for (const key of actual) {
    walk((value as JsonRecord)[key], properties[key], `${where}.${key}`);
  }
}

test("every documented response field matches what the serializers really return", () => {
  const before = comparisons;
  for (const [name, value] of Object.entries(SERIALIZED)) {
    walk(value, schemas[name], name);
  }
  assert.ok(comparisons - before >= 9, `the walk must actually compare objects, made ${comparisons - before}`);
});

test("every documented example matches the schema it illustrates", () => {
  // The docs page prints these examples verbatim, so a stale example is a
  // published lie in exactly the same way a stale schema is.
  const before = comparisons;
  for (const name of ["SubmissionListEnvelope", "SubmissionItemEnvelope", "SpeakerListEnvelope", "ScheduleListEnvelope"]) {
    const schema = schemas[name] as JsonRecord;
    const examples = schema.examples as unknown[];
    assert.ok(Array.isArray(examples) && examples.length > 0, `${name} must carry an example`);
    walk(examples[0], schema, `${name}.example`);
  }
  assert.ok(comparisons - before >= 12, `the example walk must compare objects, made ${comparisons - before}`);
});

test("the documented envelope is the envelope the helpers really produce", async () => {
  const event = { id: "event-1", name: "Forward 2026", slug: "forward-2026", timezone: "UTC" };
  const pagination = getV1PaginationMeta({ event: "forward-2026", limit: DEFAULT_V1_LIMIT, offset: 0 }, 2);

  const success = (await v1ListResponse([], event, pagination).json()) as JsonRecord;
  const envelope = schemas.SubmissionListEnvelope as JsonRecord;
  assert.deepEqual([...(envelope.required as string[])].sort(), Object.keys(success).sort());
  assert.equal(((envelope.properties as JsonRecord).version as JsonRecord).const, success.version);
  assert.equal(success.version, V1_API_VERSION);
  walk(success.meta, schemas.ListMeta, "ListMeta");

  const item = (await v1ItemResponse(SERIALIZED.Submission, event).json()) as JsonRecord;
  const itemEnvelope = schemas.SubmissionItemEnvelope as JsonRecord;
  assert.deepEqual([...(itemEnvelope.required as string[])].sort(), Object.keys(item).sort());
  walk(item.meta, schemas.ItemMeta, "ItemMeta");

  const failure = v1Error({ status: 401, code: "UNAUTHORIZED", message: "A valid API key is required." });
  assert.equal(failure.status, 401);
  const body = (await failure.json()) as JsonRecord;
  assert.deepEqual([...((schemas.ErrorEnvelope as JsonRecord).required as string[])].sort(), Object.keys(body).sort());
  assert.deepEqual(
    [...((schemas.ErrorBody as JsonRecord).required as string[])].sort(),
    Object.keys(body.error as JsonRecord).sort(),
  );
  assert.equal(body.data, null);
  assert.equal(body.meta, null);
});

test("the documented event metadata is the event selection every route makes", () => {
  const properties = Object.keys((schemas.EventMeta as JsonRecord).properties as JsonRecord).sort();
  assert.deepEqual(properties, ["id", "name", "slug", "timezone"]);
  for (const path of V1_KEYED_PATHS) {
    assert.match(
      read(ROUTE_FILE(path)),
      /select: \{ id: true, name: true, slug: true, timezone: true \}/,
      `${ROUTE_FILE(path)} no longer selects exactly the documented event fields`,
    );
  }
});

// ---------------------------------------------------------------------------
// Failure modes and ordering
// ---------------------------------------------------------------------------

/** Every `code:` / `status:` literal reachable on this surface. */
function sourceFailures() {
  const sources = [read(V1_LIB), ...V1_KEYED_PATHS.map((path) => read(ROUTE_FILE(path)))].join("\n");
  return {
    codes: new Set([...sources.matchAll(/code: "([A-Z_]+)"/g)].map(([, code]) => code)),
    statuses: new Set([...sources.matchAll(/status: (\d{3})/g)].map(([, status]) => status)),
  };
}

test("the documented error codes are exactly the codes the surface can emit", () => {
  const { codes } = sourceFailures();
  assert.ok(codes.size >= 5, `expected the full failure set, found ${[...codes].join(", ")}`);
  const documented = ((schemas.ErrorBody as JsonRecord).properties as JsonRecord).code as JsonRecord;
  assert.deepEqual([...(documented.enum as string[])].sort(), [...codes].sort());
});

test("the documented statuses are exactly the statuses the surface can return", () => {
  const { statuses } = sourceFailures();
  const documented = new Set<string>();
  for (const path of V1_KEYED_PATHS) {
    for (const status of Object.keys(operation(path).responses as JsonRecord)) documented.add(status);
  }
  assert.ok(documented.has("200"), "the success status must be documented");
  documented.delete("200");
  assert.deepEqual([...documented].sort(), [...statuses].sort());

  // Refusing without a credential is a promise, not an implementation detail:
  // keep it named. It is 401 — the surface authenticates rather than reporting
  // itself unconfigured, because a deployment can be fully configured with
  // nothing but per-event keys and no GREENROOM_API_KEY at all.
  assert.ok(statuses.has("401"), "a missing or invalid credential must still be refused");
  assert.match(read(V1_LIB), /code: "UNAUTHORIZED"/, "the 401 the document promises must still exist");

  // The superseded "not configured" answer must not come back. It was a false
  // claim about the server's state once scoped credentials existed, and the
  // published document no longer advertises it on any route.
  //
  // Asserted against CODE, not raw source: the truth table's own comment
  // explains at length why this refusal was removed, and that explanation is
  // worth keeping.
  assert.ok(!statuses.has("503"), "this surface must no longer answer 503");
  assert.doesNotMatch(
    code(V1_LIB),
    /API_KEY_NOT_CONFIGURED/,
    "the superseded unconfigured refusal must stay removed from the auth path",
  );
  assert.ok(
    !JSON.stringify(document).includes("API_KEY_NOT_CONFIGURED"),
    "the published document must not advertise a status the surface cannot return",
  );
});

test("the documented ordering guarantee is each route's own orderBy", () => {
  for (const path of V1_LIST_PATHS) {
    // Pinned to the shape the stability promise needs: a primary field
    // ascending, then `id` ascending as the tiebreaker.
    const matches = [...read(ROUTE_FILE(path)).matchAll(/orderBy: \[\{ (\w+): "asc" \}, \{ id: "asc" \}\]/g)];
    assert.equal(matches.length, 1, `${ROUTE_FILE(path)} must have exactly one stable top-level ordering`);
    assert.deepEqual(operation(path)["x-ordering"], [matches[0][1], "id"], `${path} documents the wrong ordering`);
  }
});

// ---------------------------------------------------------------------------
// Authentication, and the one route that deliberately has none
// ---------------------------------------------------------------------------

test("every documented key-gated route really authenticates before it reads", () => {
  const schemeNames = Object.keys(components.securitySchemes as JsonRecord).sort();
  assert.deepEqual(schemeNames, ["apiKeyHeader", "bearerApiKey"]);

  for (const path of V1_KEYED_PATHS) {
    const required = (operation(path).security as JsonRecord[]).flatMap((entry) => Object.keys(entry)).sort();
    assert.deepEqual(required, schemeNames, `${path} must document both accepted credential styles`);

    const source = read(ROUTE_FILE(path));
    assert.match(source, /authorizeV1Request\(req\.headers\)/, `${ROUTE_FILE(path)} must authorize`);
    // Before the query parse and before any prisma call: the order is the
    // reason an unauthenticated caller cannot probe for events.
    const authIndex = source.indexOf("authorizeV1Request");
    const prismaIndex = source.indexOf("await prisma");
    assert.ok(authIndex > 0 && authIndex < prismaIndex, `${ROUTE_FILE(path)} must authorize before it queries`);
  }
});

test("the document endpoint is unauthenticated, reads nothing, and says so", () => {
  assert.deepEqual(operation(V1_OPENAPI_PATH).security, [], "the contract endpoint must opt out of the key");

  assert.match(read(ROUTE_FILE(V1_OPENAPI_PATH)), /OPENAPI_DOCUMENT/, "it must serve the document this test checks");
  const source = code(ROUTE_FILE(V1_OPENAPI_PATH));
  for (const forbidden of [/authorizeV1Request/, /prisma/, /getV1ApiKey/, /process\.env/]) {
    assert.doesNotMatch(source, forbidden, `${ROUTE_FILE(V1_OPENAPI_PATH)} must stay static and keyless`);
  }
});

// ---------------------------------------------------------------------------
// The hard rule: no credential, ever
// ---------------------------------------------------------------------------

test("the published document contains no credential-shaped string but the placeholder", () => {
  assert.ok(JSON.stringify(document).includes(API_KEY_PLACEHOLDER), "the placeholder must be what examples use");

  // Every authored string in the document, in key order. `$ref` values are
  // skipped because they are structural pointers, not content anyone writes a
  // secret into.
  const strings: string[] = [];
  const collect = (node: unknown): void => {
    if (typeof node === "string") strings.push(node);
    else if (Array.isArray(node)) node.forEach(collect);
    else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) if (key !== "$ref") collect(value);
    }
  };
  collect(document);
  assert.ok(strings.length > 50, `the walk must reach the document, found ${strings.length} strings`);

  // Any unbroken 32+ character token is credential-shaped. The placeholder is
  // the only one allowed to be here; a pasted real key would land in this net.
  const tokens = new Set(
    strings.flatMap((value) => [...value.matchAll(/[A-Za-z0-9+/=_-]{32,}/g)].map(([token]) => token)),
  );
  assert.deepEqual([...tokens], [API_KEY_PLACEHOLDER], "a credential-shaped string reached the published document");

  // The placeholder is an instruction, not a usable key.
  assert.match(API_KEY_PLACEHOLDER, /replace/i);
});

test("nothing that builds or renders the document can read the configured key", () => {
  for (const path of [
    "lib/api/openapi.ts",
    "lib/api/openapi-view.ts",
    V1_CONTRACT_LIB,
    ROUTE_FILE(V1_OPENAPI_PATH),
    "app/docs/api/page.tsx",
  ]) {
    const source = read(path);
    assert.doesNotMatch(source, /process\.env/, `${path} must not read the environment`);
    assert.doesNotMatch(source, /getV1ApiKey/, `${path} must not resolve the API key`);
    assert.doesNotMatch(source, /GREENROOM_API_KEY="\$?\w/, `${path} must not assign a key value`);
  }
  // The curl block hands the reader a shell variable and the placeholder, so
  // nothing they copy out of this page is ever a real credential.
  const curl = CURL_EXAMPLES.flatMap((example) => example.lines).join("\n");
  assert.match(curl, new RegExp(`GREENROOM_API_KEY="${API_KEY_PLACEHOLDER}"`));
  assert.match(curl, /Authorization: Bearer \$GREENROOM_API_KEY/);
  assert.match(curl, /X-API-Key: \$GREENROOM_API_KEY/);
});

// ---------------------------------------------------------------------------
// The human page renders the document rather than restating it
// ---------------------------------------------------------------------------

test("the docs page is server-rendered and derived from the document", () => {
  const page = read("app/docs/api/page.tsx");
  assert.doesNotMatch(page, /"use client"/, "the API docs page must stay a Server Component");
  assert.match(page, /from "@\/lib\/api\/openapi"/, "the page must render the published document");
  // No hard-coded endpoint list: the page walks `paths`, so deleting a route
  // from the document removes it from the page too.
  for (const path of V1_LIST_PATHS) {
    assert.ok(!page.includes(path), `the page must not hard-code ${path}`);
  }
  const css = read("app/globals.css");
  for (const className of [
    "api-docs", "api-heading", "api-endpoint", "api-method", "api-table", "api-code", "api-warning",
  ]) {
    assert.ok(css.includes(`.${className}`), `.${className} must be defined in globals.css`);
  }
});

test("the view layer resolves the whole document without a gap", () => {
  const views = listEndpointViews();
  assert.equal(views.length, V1_LIST_PATHS.length);
  for (const view of views) {
    assert.equal(view.method, "GET");
    assert.ok(view.summary.length > 0, `${view.path} needs a summary`);
    assert.ok(view.paragraphs.length > 0, `${view.path} needs a description`);
    assert.equal(view.parameters.length, view.path === "/api/v1/submissions" ? 4 : 3);
    assert.ok(view.parameters.every((parameter) => parameter.constraint.length > 0));
    assert.ok(view.responseExample, `${view.path} must render a response example`);
    assert.deepEqual(view.errors.map((error) => error.status).sort(), ["400", "401", "404", "500"]);
    assert.ok(view.errors.every((error) => error.code.length > 0), `${view.path} errors need codes`);
  }
  assert.equal(endpointViews().length, Object.keys(paths).length);
  assert.deepEqual(
    endpointViews().find((view) => view.path === V1_OPENAPI_PATH)?.security,
    [],
  );
  assert.throws(() => resolveRef({ $ref: "#/components/schemas/NotAThing" }), /unresolved ref/);
});

test("the human API page renders every document-derived operation, including item routes", () => {
  const page = read("app/docs/api/page.tsx");
  assert.match(page, /const endpoints = endpointViews\(\);/);
  assert.match(page, /\{endpoints\.map\(\(view\) => \(/);
  assert.doesNotMatch(page, /listEndpointViews\(\)/);
  for (const path of V1_ITEM_PATHS) {
    assert.ok(endpointViews().some((view) => view.path === path), `${path} must reach the page view set`);
  }
});
