import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * T-01. `npm test` globbed `lib/**\/*.test.ts` only, so four written, passing
 * test files never ran: `types/api.public-submission.test.ts` and three
 * `scripts/*.test.mjs`. Twelve assertions about strict public-submission
 * parsing and about the smoke harness's own contracts sat in the repository
 * looking like coverage while proving nothing — the worst kind of test, because
 * its presence is what stops anyone writing the check again.
 *
 * This is the rail that keeps it fixed. It is deliberately a DISCOVERY test
 * rather than a list: it walks the tree for test files and asserts the `test`
 * script's globs would reach each one, so a fifth orphan in a fifth directory
 * fails here rather than going unnoticed for another cycle.
 *
 * CRLF-safe: no pattern below crosses a line break.
 */

const repoRoot = new URL("../", import.meta.url);
const IGNORED = new Set(["node_modules", ".next", ".git", "prisma"]);

/** Every `*.test.*` file in the repo, as repo-relative POSIX paths. */
function findTestFiles(dir = ".", out: string[] = []): string[] {
  for (const entry of readdirSync(new URL(dir, repoRoot), { withFileTypes: true })) {
    if (entry.name.startsWith(".") || IGNORED.has(entry.name)) continue;
    const rel = dir === "." ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) findTestFiles(rel, out);
    else if (/\.test\.(ts|tsx|mjs|cjs|js)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** The globs `npm test` actually passes to the runner. */
function testGlobs(): string[] {
  const pkg = JSON.parse(readFileSync(new URL("package.json", repoRoot), "utf8")) as {
    scripts: Record<string, string>;
  };
  const script = pkg.scripts.test;
  assert.ok(script, "package.json must define a `test` script");
  return [...script.matchAll(/"([^"]+)"/g)].map(([, glob]) => glob);
}

/** Minimal `**` / `*` glob match over a POSIX path. */
function matchesGlob(glob: string, file: string): boolean {
  const pattern = glob
    .split("/")
    .map((segment) => {
      if (segment === "**") return "(?:.+/)?";
      return `${segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}/`;
    })
    .join("");
  return new RegExp(`^${pattern.replace(/\/$/, "")}$`).test(file);
}

test("T-01: the glob matcher used below actually discriminates", () => {
  // Without this the whole test could pass by matching everything.
  assert.equal(matchesGlob("lib/**/*.test.ts", "lib/env.test.ts"), true);
  assert.equal(matchesGlob("lib/**/*.test.ts", "lib/services/schedule.test.ts"), true);
  assert.equal(matchesGlob("lib/**/*.test.ts", "types/api.public-submission.test.ts"), false);
  assert.equal(matchesGlob("lib/**/*.test.ts", "scripts/smoke-deadline.test.mjs"), false);
  assert.equal(matchesGlob("scripts/**/*.test.mjs", "scripts/smoke-deadline.test.mjs"), true);
  assert.equal(matchesGlob("lib/**/*.test.ts", "lib/env.ts"), false);
});

test("T-01: every test file in the repository is reached by `npm test`", () => {
  const globs = testGlobs();
  const files = findTestFiles();

  // Non-vacuity: the walk must have found the tree, including this file.
  assert.ok(files.length > 50, `expected the full suite, found ${files.length} files`);
  assert.ok(files.includes("lib/test-glob.test.ts"));

  const orphans = files.filter((file) => !globs.some((glob) => matchesGlob(glob, file)));
  assert.deepEqual(
    orphans,
    [],
    `these test files exist but never run — add a glob to the \`test\` script: ${orphans.join(", ")}`,
  );
});

test("T-01: the four files T-01 named are among them, and are reached", () => {
  // Named explicitly as well as discovered: a refactor that moves or deletes
  // one of these should be a deliberate decision, not a silent count change.
  const globs = testGlobs();
  for (const file of [
    "types/api.public-submission.test.ts",
    "scripts/smoke-c17-contract.test.mjs",
    "scripts/smoke-deadline.test.mjs",
    "scripts/smoke-s16-contract.test.mjs",
  ]) {
    assert.ok(
      globs.some((glob) => matchesGlob(glob, file)),
      `${file} is not reached by any \`npm test\` glob`,
    );
  }
  // And the original lib glob is untouched: widening must not have narrowed.
  assert.ok(globs.includes("lib/**/*.test.ts"));
});

test("T-01: no test file sits somewhere the walk cannot see it", () => {
  // The walk skips node_modules/.next/.git/prisma. Anything else is in scope,
  // so a test parked in, say, `components/` would be found and reported.
  const scanned = new Set(findTestFiles().map((file) => path.posix.dirname(file).split("/")[0]));
  assert.ok(scanned.has("lib"));
  assert.ok(scanned.has("types"));
  assert.ok(scanned.has("scripts"));
});
