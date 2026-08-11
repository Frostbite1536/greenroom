import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { OPENAPI_DOCUMENT, V1_OPENAPI_PATH } from "@/lib/api/openapi";

/**
 * The purity rail for the published contract endpoint.
 *
 * `app/api/v1/openapi.json/route.ts` is `force-static` and unauthenticated.
 * Both properties rest on the same claim: nothing the document needs can read
 * the environment, resolve a credential, open a database connection, or touch
 * request handling. A grep of the handler file cannot prove that — the handler
 * is two lines, and everything risky would arrive through an import of an
 * import.
 *
 * So this file proves it two ways that a source grep cannot:
 *
 * 1. It walks the TRANSITIVE import graph from the route and the spec modules
 *    and asserts the reachable set is exactly four pure files, with no package
 *    specifier of any kind. The walker is proven non-vacuous by pointing it at
 *    `lib/api/v1.ts`, where it must find `lib/env.ts`.
 * 2. It imports the route module with `DATABASE_URL` and `GREENROOM_API_KEY`
 *    removed from the environment and calls `GET()` directly, asserting a real
 *    200 `application/json` response whose body parses as the document.
 *
 * Source assertions are CRLF-safe: every pattern tolerates `\r`, and none
 * assumes a bare `\n`.
 */

const REPO = (path: string) => new URL(`../../${path}`, import.meta.url);
const read = (path: string) => readFileSync(REPO(path), "utf8");
const exists = (path: string) => existsSync(REPO(path));

/** Comments stripped, so a path mentioned in prose is never walked as an edge. */
const code = (path: string) =>
  read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\r\n]*/g, "$1");

const ROUTE = `app${V1_OPENAPI_PATH}/route.ts`;
const SPEC = "lib/api/openapi.ts";
const VIEW = "lib/api/openapi-view.ts";
const PURE = "lib/api/v1-contract.ts";

/**
 * Every module specifier a file imports or re-exports.
 *
 * `[^"';]*?` between the keyword and `from` spans an import's newlines but can
 * never cross a string literal or a statement end, so prose that happens to
 * contain the word "from" cannot be mistaken for an edge.
 */
function specifiersOf(path: string): string[] {
  const source = code(path);
  const found = [
    ...[...source.matchAll(/(?:\bimport\b|\bexport\b)[^"';]*?\bfrom\s*["']([^"']+)["']/g)],
    ...[...source.matchAll(/\bimport\s*["']([^"']+)["']/g)],
    ...[...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)],
  ].map(([, specifier]) => specifier);
  return [...new Set(found)];
}

/** Resolves a repo-internal specifier to a repo-relative file, or null if it is a package. */
function resolveInternal(specifier: string, importer: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = specifier.slice(2);
  } else if (specifier.startsWith(".")) {
    const dir = importer.split("/").slice(0, -1);
    for (const segment of specifier.split("/")) {
      if (segment === "." || segment === "") continue;
      if (segment === "..") dir.pop();
      else dir.push(segment);
    }
    base = dir.join("/");
  } else {
    return null;
  }
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
      if (exists(candidate)) return candidate;
    }
  }
  assert.fail(`${importer} imports "${specifier}", which resolves to no file in this repository`);
}

type Graph = { modules: Set<string>; packages: Set<string> };

/** Breadth-first walk of the real import graph from a set of entry files. */
function importGraph(entries: string[]): Graph {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (modules.has(current)) continue;
    assert.ok(exists(current), `${current} does not exist`);
    modules.add(current);
    for (const specifier of specifiersOf(current)) {
      const resolved = resolveInternal(specifier, current);
      if (resolved === null) packages.add(specifier);
      else if (!modules.has(resolved)) queue.push(resolved);
    }
  }
  return { modules, packages };
}

// ---------------------------------------------------------------------------
// The walker itself must be able to find the thing it claims is absent
// ---------------------------------------------------------------------------

test("the import walker really traverses: it finds lib/env from the runtime v1 module", () => {
  const runtime = importGraph(["lib/api/v1.ts"]);
  assert.ok(runtime.modules.has("lib/env.ts"), "the walker must reach lib/env.ts from lib/api/v1.ts");
  assert.ok(runtime.modules.has(PURE), "the walker must reach the pure module from lib/api/v1.ts");
  assert.ok(runtime.packages.has("zod"), "the walker must report package specifiers it reaches");
  assert.ok(runtime.packages.has("node:crypto"), "the walker must report builtin specifiers too");
});

test("the walker follows an edge more than one hop deep", () => {
  // lib/api/openapi-view -> lib/api/openapi -> lib/api/v1-contract. If the walk
  // stopped at depth one this assertion is the one that fails.
  assert.equal(resolveInternal("@/lib/api/openapi", VIEW), SPEC);
  assert.equal(specifiersOf(SPEC).includes("@/lib/api/v1-contract"), true);
  assert.ok(importGraph([VIEW]).modules.has(PURE), "the walk must reach the pure module two hops out");
});

// ---------------------------------------------------------------------------
// The contract graph is pure
// ---------------------------------------------------------------------------

test("the contract route and spec graph reaches exactly four pure modules", () => {
  const { modules, packages } = importGraph([ROUTE, SPEC, VIEW]);

  assert.deepEqual([...modules].sort(), [ROUTE, SPEC, VIEW, PURE].sort());

  // Not one package, not even a node builtin: a static contract document needs
  // no runtime at all, and the empty set is the cheapest thing to keep true.
  assert.deepEqual([...packages].sort(), [], "the contract graph must import no package");
});

test("nothing in the contract graph reaches env, auth, Prisma, or request handling", () => {
  const { modules, packages } = importGraph([ROUTE, SPEC, VIEW]);
  assert.ok(modules.size >= 4, `the walk must reach the whole graph, found ${modules.size}`);

  const forbiddenModule = [
    /^lib\/env(\.|\/|$)/,
    /auth/i,
    /session/i,
    /prisma/i,
    /^lib\/api\/v1\.ts$/,
    /^lib\/api\/v1-serialize\.ts$/,
    /^app\/api\/v1\/(submissions|speakers|schedule)\//,
    /^lib\/services\//,
  ];
  for (const module of modules) {
    for (const pattern of forbiddenModule) {
      assert.doesNotMatch(module, pattern, `${module} must not be reachable from the contract endpoint`);
    }
  }

  const forbiddenPackage = [/^@prisma\//, /^\.prisma/, /^next\//, /^zod$/, /^node:/, /^react/];
  for (const specifier of packages) {
    for (const pattern of forbiddenPackage) {
      assert.doesNotMatch(specifier, pattern, `the contract endpoint must not import ${specifier}`);
    }
  }

  // The pure module is the leaf: it must import nothing at all.
  assert.deepEqual(specifiersOf(PURE), [], `${PURE} must stay import-free`);
});

test("no module in the contract graph reads the environment or a credential", () => {
  for (const module of importGraph([ROUTE, SPEC, VIEW]).modules) {
    const source = code(module);
    assert.doesNotMatch(source, /process\.env/, `${module} must not read the environment`);
    assert.doesNotMatch(source, /getV1ApiKey/, `${module} must not resolve the API key`);
    assert.doesNotMatch(source, /authorizeV1Request/, `${module} must not authenticate`);
  }
});

// ---------------------------------------------------------------------------
// The handler really answers, with no environment and no database
// ---------------------------------------------------------------------------

test("GET returns 200 application/json with the document, with no env and no database", async () => {
  const saved = { ...process.env };
  delete process.env.DATABASE_URL;
  delete process.env.GREENROOM_API_KEY;
  delete process.env.SESSION_SECRET;

  try {
    // Imported AFTER the deletions, so module-evaluation-time env reads would
    // throw here rather than passing on a leftover value.
    const route = (await import("@/app/api/v1/openapi.json/route")) as {
      GET: () => Response;
      dynamic: string;
      runtime: string;
    };

    assert.equal(route.dynamic, "force-static", "the contract must be prerenderable");
    assert.equal(route.runtime, "nodejs");

    const response = route.GET();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/);

    // Parsed from the real wire body, not from the imported object.
    const body = JSON.parse(await response.text()) as Record<string, unknown>;
    assert.equal(body.openapi, "3.1.1");
    assert.equal((body.info as Record<string, unknown>).version, OPENAPI_DOCUMENT.info.version);
    assert.ok(V1_OPENAPI_PATH in (body.paths as Record<string, unknown>));
    assert.deepEqual(
      ((body.paths as Record<string, Record<string, Record<string, unknown>>>)[V1_OPENAPI_PATH].get)
        .security,
      [],
      "the served document must still advertise this endpoint as keyless",
    );

    // The handler took no argument: it cannot vary by request, so it cannot be
    // turned into a probe.
    assert.equal(route.GET.length, 0, "the contract handler must not read the request");
  } finally {
    process.env.DATABASE_URL = saved.DATABASE_URL;
    process.env.GREENROOM_API_KEY = saved.GREENROOM_API_KEY;
    process.env.SESSION_SECRET = saved.SESSION_SECRET;
    if (saved.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    if (saved.GREENROOM_API_KEY === undefined) delete process.env.GREENROOM_API_KEY;
    if (saved.SESSION_SECRET === undefined) delete process.env.SESSION_SECRET;
  }
});
