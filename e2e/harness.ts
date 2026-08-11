/**
 * Shared helpers for the browser-level suites.
 *
 * Everything here is deliberately thin: the specs read as the judge journey,
 * and this file only holds the pieces both of them need (the safety guard, the
 * reseed, persona sign-in, and a step wrapper that screenshots its own failure).
 */
import { execSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { assertDisposableDatabase, loadRepoEnv } from "./db-guard";

export type PersonaKey = "admin" | "evaluator" | "speaker";

/** The persona buttons on `/login`, by the label each one actually renders. */
const PERSONA_BUTTON: Record<PersonaKey, RegExp> = {
  admin: /^Event admin\b/,
  evaluator: /^Evaluator\b/,
  speaker: /^Speaker\b/,
};

/** Where each persona lands after a one-click sign-in (`homeForRole`). */
const PERSONA_HOME: Record<PersonaKey, string> = {
  admin: "/admin",
  evaluator: "/admin/evaluations",
  speaker: "/portal",
};

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Guard, then rebuild the demo data.
 *
 * `db:seed` wipes and rebuilds all event-scoped data, so it is idempotent and
 * safe to call before every run — which is what makes these suites re-runnable
 * rather than one-shot. The guard runs FIRST: nothing is executed against a
 * database the operator has not asserted is disposable.
 */
export function guardAndReseed(): void {
  loadRepoEnv();
  assertDisposableDatabase();
  execSync("npm run db:seed", { cwd: process.cwd(), stdio: "inherit" });
}

/**
 * A named journey step that captures its own screenshot when it fails.
 *
 * Playwright's `screenshot: "only-on-failure"` fires once, at the end of the
 * test, by which time a later navigation may have moved the page away from the
 * step that actually broke. This captures at the moment of failure and attaches
 * it to the report, then rethrows so the failure is still a failure.
 */
export async function journeyStep(page: Page, title: string, body: () => Promise<void>): Promise<void> {
  await test.step(title, async () => {
    try {
      await body();
    } catch (error) {
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      try {
        const path = test.info().outputPath(`failed-${slug}.png`);
        await page.screenshot({ path, fullPage: true });
        await test.info().attach(`failure — ${title}`, { path, contentType: "image/png" });
      } catch {
        // A screenshot failure must never mask the real one.
      }
      throw error;
    }
  });
}

/** One-click persona sign-in through the real `/login` form. */
export async function signInAs(page: Page, persona: PersonaKey): Promise<void> {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByRole("button", { name: PERSONA_BUTTON[persona] }).click();
  await page.waitForURL(`**${PERSONA_HOME[persona]}`);
}

/** Sign out through the shell control, landing back on `/login`. */
export async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await page.waitForURL("**/login");
}

/** Assert this page is being viewed by nobody — no session, no shell controls. */
export async function expectLoggedOut(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  const cookies = await page.context().cookies();
  expect(cookies.some((c) => c.name === "sb_session")).toBe(false);
}
