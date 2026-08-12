import { expect, test } from "@playwright/test";
import { guardAndReseed, signInAs } from "./harness";

test.describe("post-release operator additions", () => {
  test.beforeAll(() => guardAndReseed());

  test("documents the scoped item read and renders bounded pacing", async ({ page }) => {
    await page.goto("/docs/api");
    await expect(page.getByRole("heading", { name: "Greenroom API v1" })).toBeVisible();
    await expect(page.getByText("/api/v1/submissions/{submissionId}", { exact: true })).toBeVisible();

    await signInAs(page, "admin");
    await page.goto("/admin/reports");
    await expect(page.getByRole("heading", { name: "Submission pacing" })).toBeVisible();
    await expect(page.getByText("Covered range:")).toBeVisible();
    const pacing = page.getByRole("table", { name: "Submitted proposals per event-local day with cumulative total" });
    await expect(pacing).toBeVisible();
    await expect(pacing.getByRole("columnheader", { name: "Submitted" })).toBeVisible();
    await expect(pacing.getByRole("columnheader", { name: "Cumulative" })).toBeVisible();
  });

  test("keeps a mobile task draft safe across the live-refresh cadence", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 664 });
    await signInAs(page, "admin");
    await page.goto("/admin/speakers");

    const refreshGroup = page.getByRole("group", { name: "Speaker roster refresh" });
    const refresh = refreshGroup.getByRole("button", { name: "Refresh", exact: true });
    await expect(refreshGroup).toBeVisible();
    await expect(refreshGroup.getByRole("button", { name: "Pause live refresh" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const taskTitle = page.getByRole("textbox", { name: "Task title" }).first();
    await taskTitle.fill("Unsaved browser proof");
    await expect(refreshGroup).toContainText("Live refresh waits while you edit.");
    await expect(refresh).toBeDisabled();

    const before = await taskTitle.inputValue();
    await page.waitForTimeout(21_000);
    await expect(taskTitle).toHaveValue(before);
    await expect(refreshGroup).toContainText("Live refresh waits while you edit.");

    await taskTitle.fill("");
    await refreshGroup.getByRole("button", { name: "Pause live refresh" }).focus();
    await expect(refresh).toBeEnabled();
    await expect(refreshGroup).toContainText("Refresh requested at", { timeout: 22_000 });
  });
});
