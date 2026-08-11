import { defineConfig, devices } from "@playwright/test";
import { assertLoopbackTarget, loadRepoEnv } from "./e2e/db-guard";

/**
 * Browser-level proof harness (D-C5-15 item 1).
 *
 * Deliberately minimal: one Chromium project, one worker, no retries. These
 * suites drive a real production build against a DISPOSABLE database and their
 * value is that the run order and the data are exactly what a judge would see,
 * so parallelism and retries would only make the evidence less legible.
 *
 * Ports 3200-3299 belong to the sprint's other lanes; this harness stays out of
 * that range. Override with `E2E_PORT` or point at an already-running server
 * with `E2E_BASE_URL`.
 */
loadRepoEnv();

const PORT = Number(process.env.E2E_PORT ?? 3400);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

assertLoopbackTarget(baseURL);

/**
 * `next start` runs with NODE_ENV=production, where `getServerSigningSecret()`
 * fails closed without a >= 32 character secret — the one-click personas would
 * throw. A local, throwaway secret is supplied for the server this config
 * spawns; a secret already in the environment always wins.
 */
const LOCAL_E2E_SESSION_SECRET = "greenroom-e2e-local-only-session-secret-not-for-production";

export default defineConfig({
  testDir: "./e2e",
  // Failure artifacts (screenshots, traces) — git-ignored, never committed.
  outputDir: "./e2e/.artifacts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
    // The whole point is a real journey, so nothing is stubbed.
    serviceWorkers: "block",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    // A production server, not `next dev`: the judged application is the built
    // one. Requires `npm run build` first — see e2e/README.md.
    command: `npx next start -p ${PORT}`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      SESSION_SECRET: process.env.SESSION_SECRET ?? LOCAL_E2E_SESSION_SECRET,
    },
  },
});
