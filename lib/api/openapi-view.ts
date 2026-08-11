/**
 * Turns `OPENAPI_DOCUMENT` into the shapes `/docs/api` renders.
 *
 * The human page must not be a second, hand-written description of the API —
 * that is exactly the drift the roadmap's item 1 asks for a test against. So
 * the page renders these views, every one of which is derived from the document
 * at request time: change the spec and the page changes with it, or the drift
 * test fails because the spec no longer matches the routes.
 *
 * `$ref` resolution here is deliberately minimal — local `#/components/...`
 * pointers only, which is all this document uses. It is not a general OpenAPI
 * resolver and should not grow into one.
 */
import { OPENAPI_DOCUMENT, V1_LIST_PATHS } from "@/lib/api/openapi";

type JsonRecord = Record<string, unknown>;

const doc = OPENAPI_DOCUMENT as unknown as JsonRecord;

/** Follows one local `#/a/b/c` pointer; returns non-refs unchanged. */
export function resolveRef(node: unknown): JsonRecord {
  const record = (node ?? {}) as JsonRecord;
  const ref = record.$ref;
  if (typeof ref !== "string") return record;
  if (!ref.startsWith("#/")) throw new Error(`only local refs are supported: ${ref}`);
  let current: unknown = doc;
  for (const segment of ref.slice(2).split("/")) {
    current = (current as JsonRecord | undefined)?.[segment];
    if (current === undefined) throw new Error(`unresolved ref: ${ref}`);
  }
  return resolveRef(current);
}

export type ParameterView = {
  name: string;
  required: boolean;
  description: string;
  /** A short, human "integer, 1–100, default 50" line built from the schema. */
  constraint: string;
};

export type ErrorView = { status: string; code: string; description: string };

export type EndpointView = {
  path: string;
  method: string;
  summary: string;
  /** Paragraphs, already split on the blank lines the document uses. */
  paragraphs: string[];
  /** Empty when the operation is deliberately unauthenticated. */
  security: string[];
  parameters: ParameterView[];
  ordering: string[];
  /** A pretty-printed success body, taken from the schema's own example. */
  responseExample: string | null;
  errors: ErrorView[];
};

/** "integer, 1–100, default 50" from a parameter's schema. */
function describeSchema(schema: JsonRecord): string {
  const parts: string[] = [];
  const type = schema.type;
  if (typeof type === "string") parts.push(type);
  else if (Array.isArray(type)) parts.push(type.join(" or "));

  const { minimum, maximum, minLength, maxLength } = schema;
  if (typeof minimum === "number" && typeof maximum === "number") {
    parts.push(`${minimum}–${maximum}`);
  }
  if (typeof minLength === "number" && typeof maxLength === "number") {
    parts.push(`${minLength}–${maxLength} characters`);
  }
  if (schema.default !== undefined) parts.push(`default ${String(schema.default)}`);
  return parts.join(", ");
}

/** Splits a description on the blank lines the document writes between paragraphs. */
export function paragraphsOf(value: unknown): string[] {
  return typeof value === "string" ? value.split("\n\n").filter(Boolean) : [];
}

/**
 * The one piece of markdown these descriptions use is `backtick code`. Rendering
 * it is four lines of split, so the page can show `503 API_KEY_NOT_CONFIGURED`
 * as code without a markdown dependency — and this repository does not add one.
 */
export function inlineCodeSegments(text: string): { text: string; code: boolean }[] {
  return text
    .split(/`([^`]+)`/g)
    .map((part, index) => ({ text: part, code: index % 2 === 1 }))
    .filter((segment) => segment.text.length > 0);
}

/** The first documented example on a schema, pretty-printed for a `<pre>`. */
function firstExample(schema: JsonRecord): string | null {
  const examples = schema.examples;
  if (!Array.isArray(examples) || examples.length === 0) return null;
  return JSON.stringify(examples[0], null, 2);
}

function operationView(path: string, method: string, operation: JsonRecord): EndpointView {
  const security = Array.isArray(operation.security)
    ? operation.security.flatMap((requirement) => Object.keys(requirement as JsonRecord))
    : [];

  const parameters = (Array.isArray(operation.parameters) ? operation.parameters : []).map(
    (raw): ParameterView => {
      const parameter = resolveRef(raw);
      return {
        name: String(parameter.name),
        required: parameter.required === true,
        description: typeof parameter.description === "string" ? parameter.description : "",
        constraint: describeSchema(resolveRef(parameter.schema)),
      };
    },
  );

  const responses = (operation.responses ?? {}) as JsonRecord;
  const success = resolveRef(responses["200"]);
  const successSchema = resolveRef(
    ((resolveRef((success.content ?? {}) as JsonRecord)["application/json"] ?? {}) as JsonRecord).schema,
  );

  const errors = Object.entries(responses)
    .filter(([status]) => status !== "200")
    .map(([status, raw]): ErrorView => {
      const response = resolveRef(raw);
      const media = ((response.content ?? {}) as JsonRecord)["application/json"] as JsonRecord | undefined;
      const examples = media?.examples;
      const example = (Array.isArray(examples) ? examples[0] : undefined) as JsonRecord | undefined;
      const code = (example?.error as JsonRecord | undefined)?.code;
      return {
        status,
        code: typeof code === "string" ? code : "",
        description: typeof response.description === "string" ? response.description : "",
      };
    });

  return {
    path,
    method,
    summary: typeof operation.summary === "string" ? operation.summary : "",
    paragraphs: paragraphsOf(operation.description),
    security,
    parameters,
    ordering: Array.isArray(operation["x-ordering"]) ? (operation["x-ordering"] as string[]) : [],
    responseExample: firstExample(successSchema),
    errors,
  };
}

/** Every documented operation, in document order. */
export function endpointViews(): EndpointView[] {
  const paths = (doc.paths ?? {}) as JsonRecord;
  return Object.entries(paths).flatMap(([path, item]) =>
    Object.entries((item ?? {}) as JsonRecord).map(([method, operation]) =>
      operationView(path, method.toUpperCase(), operation as JsonRecord),
    ),
  );
}

/** Just the three key-gated list operations, in the document's stated order. */
export function listEndpointViews(): EndpointView[] {
  const views = endpointViews();
  return V1_LIST_PATHS.map((path) => {
    const view = views.find((candidate) => candidate.path === path);
    if (!view) throw new Error(`${path} is missing from the OpenAPI document`);
    return view;
  });
}

/** The named authentication schemes, for the page's own auth section. */
export function securitySchemeViews(): { name: string; header: string; paragraphs: string[] }[] {
  const schemes = ((doc.components as JsonRecord).securitySchemes ?? {}) as JsonRecord;
  return Object.entries(schemes).map(([name, raw]) => {
    const scheme = raw as JsonRecord;
    const header =
      scheme.type === "http" ? "Authorization" : String(scheme.name ?? "");
    return { name, header, paragraphs: paragraphsOf(scheme.description) };
  });
}
