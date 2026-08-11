/**
 * Browser proof for deterministic resource templates and sanitized preview.
 *
 * This suite writes only to the disposable database enforced by the shared E2E
 * guard. It deliberately exercises the existing save and publish controls
 * separately: templates and preview are authoring aids, never publication.
 */
import { expect, test } from "@playwright/test";
import { guardAndReseed, signInAs, signOut } from "./harness";

const TITLE = "Resource template browser proof";
const SUMMARY = "Metadata that a template must preserve.";

test.describe("resource templates and preview", () => {
  test.beforeAll(() => {
    guardAndReseed();
  });

  test("an organizer previews safely, saves a draft, then publishes explicitly", async ({ page }) => {
    await signInAs(page, "admin");
    await page.goto("/admin/resources");
    await page.getByRole("button", { name: "New resource page" }).click();

    const dialog = page.getByRole("dialog", { name: "New resource page" });
    const title = dialog.getByLabel("Page title");
    const slug = dialog.getByLabel("Portal address");
    const summary = dialog.getByLabel(/Summary/);
    const template = dialog.getByLabel(/Start from a template/);
    const published = dialog.getByLabel(/Published/);

    await title.fill(TITLE);
    await summary.fill(SUMMARY);
    await expect(slug).toHaveValue("resource-template-browser-proof");
    await expect(published).not.toBeChecked();

    await template.selectOption("speaker-handbook");
    await expect(dialog.getByLabel("Page content (HTML)")).toContainText("Welcome, speakers");
    await expect(title).toHaveValue(TITLE);
    await expect(slug).toHaveValue("resource-template-browser-proof");
    await expect(summary).toHaveValue(SUMMARY);
    await expect(published).not.toBeChecked();

    const handbookHtml = await dialog.getByLabel("Page content (HTML)").inputValue();
    page.once("dialog", async (confirmation) => {
      expect(confirmation.message()).toContain("replace the HTML currently in this editor");
      await confirmation.dismiss();
    });
    await template.selectOption("venue-travel");
    await expect(dialog.getByLabel("Page content (HTML)")).toHaveValue(handbookHtml);
    await expect(template).toHaveValue("speaker-handbook");

    page.once("dialog", async (confirmation) => {
      expect(confirmation.message()).toContain("Page details and publish state stay unchanged");
      await confirmation.accept();
    });
    await template.selectOption("venue-travel");
    const html = dialog.getByLabel("Page content (HTML)");
    await expect(html).toContainText("Venue and travel");

    const templateHtml = await html.inputValue();
    await html.fill(
      `${templateHtml}<p onclick="globalThis.__RESOURCE_PREVIEW_SCRIPT=true">Browser proof edit</p>`
        + "<script>globalThis.__RESOURCE_PREVIEW_SCRIPT=true</script>"
        + '<iframe src="https://example.invalid"></iframe>'
        + '<a href="javascript:alert(1)">Unsafe link</a>',
    );

    const htmlTab = dialog.getByRole("tab", { name: "HTML" });
    const previewTab = dialog.getByRole("tab", { name: "Preview" });
    await htmlTab.focus();
    await htmlTab.press("End");
    await expect(previewTab).toBeFocused();
    await expect(previewTab).toHaveAttribute("aria-selected", "true");

    const preview = dialog.getByRole("tabpanel", { name: "Preview" });
    await expect(preview.getByText("Venue and travel", { exact: true })).toBeVisible();
    await expect(preview.getByText("Browser proof edit", { exact: true })).toBeVisible();
    await expect(preview.locator("script, iframe, svg, style")).toHaveCount(0);
    await expect(preview.locator("a").filter({ hasText: "Unsafe link" })).not.toHaveAttribute("href", /.+/);
    expect(
      await page.evaluate(() => (globalThis as { __RESOURCE_PREVIEW_SCRIPT?: boolean }).__RESOURCE_PREVIEW_SCRIPT),
    ).toBeUndefined();

    await previewTab.press("Home");
    await expect(htmlTab).toBeFocused();
    await expect(htmlTab).toHaveAttribute("aria-selected", "true");

    // Return to the assistant-supported template named in the golden path.
    page.once("dialog", async (confirmation) => {
      expect(confirmation.message()).toContain("replace the HTML currently in this editor");
      await confirmation.accept();
    });
    await template.selectOption("speaker-handbook");
    const handbookBeforeAssistant = await html.inputValue();

    const notes = dialog.getByLabel("Facts and notes");
    await notes.fill("Slides are due Friday. Check in with the speaker team. Leave unknown event details visible.");
    await dialog.getByRole("button", { name: "Generate suggestion" }).click();
    await expect(dialog.getByRole("status")).toContainText("Draft suggestion ready");

    const suggestion = dialog.locator(".resource-assistant-suggestion");
    await expect(suggestion).toBeFocused();
    await expect(suggestion.getByRole("heading", { name: "Generated suggestion" })).toBeVisible();
    await expect(suggestion.getByText("Slides are due Friday.", { exact: true })).toBeVisible();
    await expect(suggestion.getByText("[Add speaker check-in time]", { exact: true })).toBeVisible();
    await expect(suggestion.locator("script, iframe, svg, style")).toHaveCount(0);
    await expect(suggestion.getByRole("link", { name: "Unsafe link" })).not.toHaveAttribute("href", /.+/);
    expect(
      await page.evaluate(() => (globalThis as { __ASSISTANT_PREVIEW_EXECUTED?: boolean }).__ASSISTANT_PREVIEW_EXECUTED),
    ).toBeUndefined();
    // Generation is only a suggestion. It cannot silently replace the editor.
    await expect(html).toHaveValue(handbookBeforeAssistant);

    page.once("dialog", async (confirmation) => {
      expect(confirmation.message()).toContain("Use this draft and replace the HTML currently in this editor");
      await confirmation.dismiss();
    });
    await suggestion.getByRole("button", { name: "Use this draft" }).click();
    await expect(html).toHaveValue(handbookBeforeAssistant);

    page.once("dialog", async (confirmation) => {
      expect(confirmation.message()).toContain("Page details and publish state stay unchanged");
      await confirmation.accept();
    });
    await suggestion.getByRole("button", { name: "Use this draft" }).click();
    await expect(html).toContainText("Slides are due Friday.");
    await expect(html).not.toContainText("script");
    await html.fill(`${await html.inputValue()}<p>Organizer edit after generation.</p>`);
    const appliedAndEdited = await html.inputValue();

    // A failed retry leaves both the current editor and the prior suggestion.
    await notes.fill("[mock:provider-error] Keep the current editor unchanged.");
    await dialog.getByRole("button", { name: "Try again" }).click();
    await expect(dialog.getByRole("alert")).toContainText("provider could not create a suggestion");
    await expect(html).toHaveValue(appliedAndEdited);
    await expect(suggestion.getByText("Slides are due Friday.", { exact: true })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await expect(template).toBeVisible();
    await expect(notes).toBeVisible();
    await expect(suggestion.getByRole("button", { name: "Use this draft" })).toBeVisible();
    await expect(htmlTab).toBeVisible();
    await expect(previewTab).toBeVisible();

    const create = dialog.getByRole("button", { name: "Create page" });
    await create.scrollIntoViewIfNeeded();
    await create.click();
    await expect(dialog).toHaveCount(0);

    const draftRow = page.getByRole("row").filter({ hasText: TITLE });
    await expect(draftRow).toContainText("Draft");

    // The shared persona helper intentionally uses the desktop shell's visible
    // sign-out control. Mobile behavior was proven above; restore its viewport
    // before moving between personas so this test does not conflate the two.
    await page.setViewportSize({ width: 1440, height: 900 });
    await signOut(page);
    await signInAs(page, "speaker");
    await expect(page.getByRole("link", { name: new RegExp(TITLE) })).toHaveCount(0);

    await signOut(page);
    await signInAs(page, "admin");
    await page.goto("/admin/resources");
    const resourceRow = page.getByRole("row").filter({ hasText: TITLE });
    await resourceRow.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(resourceRow).toContainText("Published");

    await signOut(page);
    await signInAs(page, "speaker");
    const resourceLink = page.getByRole("link", { name: new RegExp(TITLE) });
    await expect(resourceLink).toBeVisible();
    await resourceLink.click();
    await expect(page.getByRole("heading", { name: TITLE })).toBeVisible();
    const publishedEdit = page.getByText("Organizer edit after generation.", { exact: true });
    await expect(publishedEdit).toBeVisible();
    const publishedContent = publishedEdit.locator("xpath=ancestor::section[1]");
    await expect(publishedContent.getByText("Slides are due Friday.", { exact: true })).toBeVisible();
    await expect(publishedContent.locator("script, iframe, svg, style")).toHaveCount(0);
    await expect(publishedContent.locator("a").filter({ hasText: "Unsafe link" })).not.toHaveAttribute("href", /.+/);
  });
});
