import { defineConfig, devices } from "@playwright/test";
import { assertDisposableDatabase, assertLoopbackTarget, loadRepoEnv } from "./e2e/db-guard";

/**
 * Browser-level proof harness (D-C5-15 item 1).
 *
 * One Chromium worker and no retries keep the database-writing golden path
 * deterministic. Both the application and paid-provider replacement are owned
 * processes; an existing listener is a hard failure.
 */
loadRepoEnv();
assertDisposableDatabase();

const rawPort = process.env.E2E_PORT?.trim() || "3400";
const PORT = Number(rawPort);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
  throw new Error("E2E_PORT must be an integer from 1 through 65535.");
}
const baseURL = `http://127.0.0.1:${PORT}`;
const validatedDatabaseUrl = process.env.DATABASE_URL!;

const rawAssistantPort = process.env.E2E_ASSISTANT_PORT?.trim() || "3413";
const ASSISTANT_PORT = Number(rawAssistantPort);
if (!Number.isInteger(ASSISTANT_PORT) || ASSISTANT_PORT < 1 || ASSISTANT_PORT > 65_535) {
  throw new Error("E2E_ASSISTANT_PORT must be an integer from 1 through 65535.");
}
if (ASSISTANT_PORT === PORT) {
  throw new Error("E2E_ASSISTANT_PORT must differ from E2E_PORT.");
}
const assistantBaseURL = `http://127.0.0.1:${ASSISTANT_PORT}`;
const assistantEndpoint = `${assistantBaseURL}/v1/responses`;

assertLoopbackTarget(baseURL);
assertLoopbackTarget(assistantBaseURL);

const LOCAL_E2E_SESSION_SECRET = "greenroom-e2e-local-only-session-secret-not-for-production";

export default defineConfig({
  testDir: "./e2e",
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
    serviceWorkers: "block",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      command: `node e2e/assistant-provider-mock.mjs ${ASSISTANT_PORT}`,
      url: `${assistantBaseURL}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      // The judged application is the production build, never `next dev`.
      command: `npx next start -p ${PORT}`,
      url: baseURL,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: "ignore",
      stderr: "pipe",
      env: {
        DATABASE_URL: validatedDatabaseUrl,
        SESSION_SECRET: process.env.SESSION_SECRET ?? LOCAL_E2E_SESSION_SECRET,
        MOCK_EXTERNAL_APIS: "true",
        DEMO_PERSONA_LOGIN_ENABLED: "true",
        OPENAI_API_KEY: "greenroom-e2e-owned-provider-key-not-a-secret",
        ASSISTANT_ENDPOINT_OVERRIDE: assistantEndpoint,
      },
    },
  ],
});
