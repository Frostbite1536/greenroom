import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertDisposableDatabase, EXPECTED_DB_VAR } from "../e2e/db-guard";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the disposable-database guard refuses missing and mismatched assertions", () => {
  assert.throws(
    () => assertDisposableDatabase({ DATABASE_URL: "postgresql://local/db" }),
    new RegExp(`Set ${EXPECTED_DB_VAR}`),
  );
  assert.throws(
    () => assertDisposableDatabase({ [EXPECTED_DB_VAR]: "throwaway" }),
    /DATABASE_URL is not set/,
  );
  assert.throws(
    () => assertDisposableDatabase({
      [EXPECTED_DB_VAR]: "throwaway",
      DATABASE_URL: "postgresql://local/shared-demo",
    }),
    /Refusing to run/,
  );
  assert.equal(
    assertDisposableDatabase({
      [EXPECTED_DB_VAR]: "throwaway",
      DATABASE_URL: "postgresql://local/greenroom-throwaway",
    }),
    "throwaway",
  );
});

test("the Playwright config owns one canonical server with the validated database", () => {
  const config = source("playwright.config.ts");
  const load = config.indexOf("loadRepoEnv();");
  const databaseGuard = config.indexOf("assertDisposableDatabase();");
  const definition = config.indexOf("export default defineConfig({");

  assert.ok(load >= 0 && databaseGuard > load && definition > databaseGuard);
  assert.match(config, /const rawPort = process\.env\.E2E_PORT\?\.trim\(\) \|\| "3400";/);
  assert.match(config, /Number\.isInteger\(PORT\) \|\| PORT < 1 \|\| PORT > 65_535/);
  assert.match(config, /const baseURL = `http:\/\/127\.0\.0\.1:\$\{PORT\}`;/);
  assert.doesNotMatch(config, /E2E_BASE_URL/);
  assert.match(config, /command: `npx next start -p \$\{PORT\}`/);
  assert.match(config, /reuseExistingServer: false/);
  assert.match(config, /DATABASE_URL: validatedDatabaseUrl/);
  assert.equal((config.match(/\bbaseURL\b/g) ?? []).length >= 3, true);
});

test("the destructive seed retains its own guard and the docs forbid server reuse", () => {
  const harness = source("e2e/harness.ts");
  const guard = harness.indexOf("assertDisposableDatabase();");
  const seed = harness.indexOf('execSync("npm run db:seed"');
  assert.ok(guard >= 0 && seed > guard);

  const readme = source("e2e/README.md");
  assert.doesNotMatch(readme, /E2E_BASE_URL|reuses an already-running server/);
  assert.match(readme, /never reuses an independently\s+started server/);
});
