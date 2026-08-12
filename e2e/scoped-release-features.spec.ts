import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { guardAndReseed, signInAs, signOut } from "./harness";

const prisma = new PrismaClient();
const DRAFT_TITLE = "Scoped release browser proof";
const KEY_LABEL = "Track A browser proof";

let draftId = "";

test.describe("scoped credentials, attachments, and event decks", () => {
  test.beforeAll(async () => {
    guardAndReseed();
    const [event, speaker, form] = await Promise.all([
      prisma.event.findUniqueOrThrow({ where: { slug: "forward-2026" }, select: { id: true } }),
      prisma.user.findUniqueOrThrow({ where: { email: "sofia@greenroom-hq.com" }, select: { id: true } }),
      prisma.formConfig.findFirstOrThrow({
        where: { event: { slug: "forward-2026" }, published: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      }),
    ]);
    const draft = await prisma.abstract.create({
      data: {
        eventId: event.id,
        formConfigId: form.id,
        submitterId: speaker.id,
        title: DRAFT_TITLE,
        abstract: "A disposable proposal used only by the scoped release browser proof.",
        status: "DRAFT",
        speakers: { create: [{ userId: speaker.id, isPrimary: true }] },
      },
      select: { id: true },
    });
    draftId = draft.id;
  });

  test.afterAll(async () => {
    await prisma.$disconnect();
  });

  test("the scoped release surfaces work through their real browser contracts", async ({ page }) => {
    await signInAs(page, "admin");
    await page.goto("/admin/settings");
    await expect(page.getByRole("heading", { name: "API access" })).toBeVisible();

    await page.getByRole("button", { name: "New API key" }).click();
    const createDialog = page.getByRole("dialog", { name: "New API key" });
    await createDialog.getByLabel("Key name").fill(KEY_LABEL);
    await createDialog.getByRole("button", { name: "Create key" }).click();

    const issuedDialog = page.getByRole("dialog", { name: "API key created" });
    const token = await issuedDialog.getByLabel(KEY_LABEL).inputValue();
    expect(token).toMatch(/^grk_[a-f0-9]{16}_[A-Za-z0-9_-]{43}$/);
    await issuedDialog.getByRole("button", { name: "I have copied it" }).click();
    await expect(issuedDialog).not.toBeVisible();
    await expect(page.locator("body")).not.toContainText(token);

    const ownEvent = await page.request.get("/api/v1/schedule?event=forward-2026", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ownEvent.status()).toBe(200);
    const otherEvent = await page.request.get("/api/v1/schedule?event=not-this-event", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(otherEvent.status()).toBe(401);

    const credentialRow = page.getByRole("row", { name: new RegExp(KEY_LABEL) });
    page.once("dialog", (dialog) => dialog.accept());
    await credentialRow.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByRole("status")).toContainText(`Revoked ${KEY_LABEL}.`);
    const revoked = await page.request.get("/api/v1/schedule?event=forward-2026", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(revoked.status()).toBe(401);

    await signOut(page);
    await signInAs(page, "speaker");
    await page.goto(`/portal/submissions/${draftId}`);
    await expect(page.getByLabel("Talk title")).toHaveValue(DRAFT_TITLE);

    const supportingPdf = Buffer.from("%PDF-1.4\n% scoped supporting document\n%%EOF\n", "utf8");
    await page.getByLabel("Add a supporting document").setInputFiles({
      name: "speaker-notes.pdf",
      mimeType: "application/pdf",
      buffer: supportingPdf,
    });
    const attachmentLink = page.getByRole("link", { name: "speaker-notes.pdf" });
    await expect(attachmentLink).toBeVisible();
    const attachmentHref = await attachmentLink.getAttribute("href") as string;
    const attachmentResponse = await page.evaluate(async (href) => {
      const response = await fetch(href);
      return { status: response.status, cacheControl: response.headers.get("cache-control") };
    }, attachmentHref);
    expect(attachmentResponse.status).toBe(200);
    expect(attachmentResponse.cacheControl).toContain("no-store");
    await page.getByRole("button", { name: "Remove speaker-notes.pdf" }).click();
    await expect(attachmentLink).toHaveCount(0);

    await page.goto("/portal");
    const eventDeckUpload = page.getByLabel(/upload a slide deck for/i);
    await eventDeckUpload.setInputFiles({
      name: "event-deck.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n% scoped event deck\n%%EOF\n", "utf8"),
    });
    await expect(page.getByRole("status", { name: "" }).filter({ hasText: "Uploaded event-deck.pdf." })).toBeVisible();
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByText("Profile saved.", { exact: true })).toBeVisible();

    await signOut(page);
    await signInAs(page, "admin");
    await page.goto("/admin/speakers");
    const speakerRow = page.getByRole("row", { name: /Sofia Marques/ });
    await expect(speakerRow.getByRole("link", { name: "Slide deck" })).toBeVisible();
    await expect(speakerRow).toContainText("This event");
  });
});
