/**
 * Scripted capture of the judging shot list (D-C5-15 item 1, second half).
 *
 * Every row of `docs/judging/SCREENSHOT-INDEX.md` is captured here from a real
 * browser against a real production build on the disposable database. Rows that
 * need a state the seed does not provide — an open dialog, a server refusal, a
 * conditional question that only appears after an answer — are DRIVEN with
 * Playwright first and then photographed. Nothing on any of these pages is
 * faked, stubbed or hand-edited.
 *
 * Written per row: one PNG into `docs/judging/screenshots/`, plus a
 * `capture-manifest.json` recording, for each file, the URL path, the role, the
 * viewport and the capture timestamp — the metadata the index table carries.
 *
 * ⚠️ This suite WRITES (it submits one proposal and attempts one refused
 * placement). See `e2e/README.md` and `e2e/db-guard.ts`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { guardAndReseed, signInAs } from "./harness";

const SHOTS_DIR = resolve(process.cwd(), "docs/judging/screenshots");
const DESKTOP = { width: 1440, height: 900 } as const;
const MOBILE = { width: 390, height: 844 } as const;

type Manifest = {
  file: string;
  path: string;
  access: string;
  viewport: string;
  fullPage: boolean;
  capturedAt: string;
}[];

const manifest: Manifest = [];

/**
 * One shot.
 *
 * `fullPage` is the default because most rows name content below 900px — a
 * viewport-only capture would silently omit the very thing the row asks to see.
 * The dialog rows opt out: a modal is fixed-positioned, so a full-page capture
 * strands it above a dimmed page instead of showing it as the operator sees it.
 */
async function shoot(
  page: Page,
  file: string,
  options: { access: string; fullPage?: boolean } ,
): Promise<void> {
  const fullPage = options.fullPage ?? true;
  const viewport = page.viewportSize() ?? DESKTOP;
  // Let webfonts, images and any entrance transition settle before the shutter.
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(250);
  await page.screenshot({ path: resolve(SHOTS_DIR, file), fullPage });
  manifest.push({
    file,
    path: new URL(page.url()).pathname + new URL(page.url()).search,
    access: options.access,
    viewport: `${viewport.width} × ${viewport.height}`,
    fullPage,
    capturedAt: new Date().toISOString(),
  });
}

/** A fresh, never-signed-in context — the index's definition of "logged out". */
async function anonymousPage(browser: Browser, viewport: typeof DESKTOP | typeof MOBILE): Promise<Page> {
  const context = await browser.newContext({ viewport });
  return context.newPage();
}

test.describe.configure({ mode: "serial" });

test.describe("judging screenshots", () => {
  test.beforeAll(async ({ browser }) => {
    guardAndReseed();
    mkdirSync(SHOTS_DIR, { recursive: true });

    // The email-history row needs at least one real dispatch. The seed writes
    // none, so one proposal is submitted through the public form — which mints
    // the submitter's receipt (mocked, per MOCK_EXTERNAL_APIS) and with it the
    // EmailDispatch row that page reads.
    const page = await anonymousPage(browser, DESKTOP);
    const stamp = Date.now();
    await page.goto("/cfp/forward-2026/call-for-speakers");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByLabel("Session title").fill(`Evidence capture proposal ${stamp}`);
    await page
      .getByLabel("Abstract")
      .fill("Submitted by the evidence-capture run so the email history has a real dispatch to show.");
    await page.getByLabel("Topic category").selectOption({ index: 1 });
    await page.getByLabel("Audience level").selectOption({ label: "Intermediate" });
    await page.getByLabel("What will attendees learn?").fill("1) Why evidence is captured. 2) From what. 3) When.");
    await page.getByLabel("I agree to the code of conduct").check();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByLabel("Full name (primary)").fill("Evidence Capture");
    await page.getByLabel("Email").fill(`evidence.capture.${stamp}@speakers.demo`);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("button", { name: "Submit proposal" }).click();
    await expect(page.getByRole("heading", { name: "Submission received" })).toBeVisible();
    await page.context().close();
  });

  test.afterAll(() => {
    writeFileSync(
      resolve(SHOTS_DIR, "capture-manifest.json"),
      `${JSON.stringify({ capturedAt: new Date().toISOString(), shots: manifest }, null, 2)}\n`,
    );
  });

  test("public surfaces, logged out, desktop", async ({ browser }) => {
    const page = await anonymousPage(browser, DESKTOP);

    // 1 — sign-in
    await page.goto("/login");
    await expect(page.getByRole("button", { name: /^Event admin/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "Create one" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Reset it" })).toBeVisible();
    await shoot(page, "login.png", { access: "logged out" });

    // 2 — public landing page
    await page.goto("/");
    await expect(page.getByText("Forward 2026").first()).toBeVisible();
    await shoot(page, "landing.png", { access: "logged out" });

    // 3 — public call for speakers, on the step that carries the topic selector
    //     and the custom questions.
    await page.goto("/cfp/forward-2026/call-for-speakers");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByLabel("Topic category")).toBeVisible();
    await expect(page.getByLabel("Audience level")).toBeVisible();
    await shoot(page, "public-cfp.png", { access: "logged out" });

    // 3b — the co-speaker block with its role field lives on the next step of
    //      the same form, so it cannot share a frame with the row above. The
    //      form will not advance past its own required questions, which is
    //      itself the behaviour the row above is evidence of, so they are
    //      answered here first.
    await page.getByLabel("Session title").fill("Sample proposal (evidence capture)");
    await page.getByLabel("Audience level").selectOption({ label: "Intermediate" });
    await page.getByLabel("What will attendees learn?").fill("1) Context. 2) Tradeoffs. 3) A checklist.");
    await page.getByLabel("I agree to the code of conduct").check();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("button", { name: "Add co-speaker" }).click();
    await expect(page.getByRole("heading", { name: "Participants" })).toBeVisible();
    await shoot(page, "public-cfp-participants.png", { access: "logged out" });

    // 18 — public schedule (embed surface)
    await page.goto("/embed/schedule?event=forward-2026");
    await expect(page.getByText("Opening Keynote").first()).toBeVisible();
    await shoot(page, "public-schedule.png", { access: "logged out" });

    // 20 — public speaker directory (embed surface)
    await page.goto("/embed/speakers?event=forward-2026");
    await expect(page.getByText("Sofia Marques").first()).toBeVisible();
    // The row asks for an expanded full profile, so one is opened. It is a
    // native <details>, which works with JavaScript switched off.
    await page.locator("details.speaker-detail").first().locator("summary").click();
    await expect(page.getByText(/^About /).first()).toBeVisible();
    await shoot(page, "public-speakers.png", { access: "logged out" });

    await page.context().close();
  });

  test("public surfaces, logged out, mobile", async ({ browser }) => {
    const page = await anonymousPage(browser, MOBILE);

    // 19 — the responsive evidence the contract asks for, plus the other two
    //      public surfaces at the same phone width.
    await page.goto("/embed/schedule?event=forward-2026");
    await expect(page.getByText("Opening Keynote").first()).toBeVisible();
    await shoot(page, "public-schedule-mobile.png", { access: "logged out" });

    await page.goto("/embed/speakers?event=forward-2026");
    await expect(page.getByText("Sofia Marques").first()).toBeVisible();
    await shoot(page, "public-speakers-mobile.png", { access: "logged out" });

    await page.goto("/cfp/forward-2026/call-for-speakers");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByLabel("Topic category")).toBeVisible();
    await shoot(page, "public-cfp-mobile.png", { access: "logged out" });

    await page.context().close();
  });

  test("organizer surfaces", async ({ browser }) => {
    const context = await browser.newContext({ viewport: DESKTOP });
    const page = await context.newPage();
    await signInAs(page, "admin");

    // 4 — event settings, including the New event button
    await page.goto("/admin/settings");
    await expect(page.getByRole("button", { name: "New event" })).toBeVisible();
    await shoot(page, "event-settings.png", { access: "ADMIN" });

    // 5 — the New event dialog, driven open
    await page.getByRole("button", { name: "New event" }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "New event" })).toBeVisible();
    await shoot(page, "new-event-dialog.png", { access: "ADMIN", fullPage: false });
    await page.keyboard.press("Escape");

    // 6 — the CFP form builder for the seeded call
    await page.goto("/admin/forms");
    // Scoped to `main`: the workspace sidebar carries its own "Submit a talk:
    // 2026 Call for Speakers" link to the public form.
    await page.getByRole("main").getByRole("link", { name: /2026 Call for Speakers/ }).first().click();
    await page.waitForURL(/\/admin\/forms\/[^/]+$/);
    // The builder is stepped, so the question list and the Published switch
    // cannot share a frame: "Form questions" carries the list, the live preview
    // and the conditional rule; "Form settings" carries the switch and window.
    await expect(page.getByText("Live preview")).toBeVisible();
    await expect(page.getByText("Audience level").first()).toBeVisible();
    await shoot(page, "cfp-builder.png", { access: "ADMIN" });

    await page.getByRole("button", { name: /Form settings/ }).click();
    await expect(page.getByText("Public submissions are accepted while published")).toBeVisible();
    await shoot(page, "cfp-builder-settings.png", { access: "ADMIN" });

    // 7 — the submission pipeline: chips, metrics, Export CSV
    await page.goto("/admin/abstracts");
    await expect(page.getByRole("link", { name: /Export CSV/ })).toBeVisible();
    await shoot(page, "admin-abstracts.png", { access: "ADMIN" });

    // 7b — one proposal open, showing the custom answers under their own labels
    await page.getByRole("row").filter({ hasText: "Accepted" }).first()
      .getByRole("button", { name: /^View / }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByText("Form answers")).toBeVisible();
    await drawer.getByText("Form answers").scrollIntoViewIfNeeded();
    await shoot(page, "admin-abstracts-drawer.png", { access: "ADMIN", fullPage: false });
    await drawer.getByRole("button", { name: "Close" }).click();

    // 8 — review round setup (rubric weight share, round window dates)
    await page.goto("/admin/evaluations");
    await expect(page.getByText(/% of rubric weight/).first()).toBeVisible();
    await shoot(page, "evaluation-setup.png", { access: "ADMIN" });

    // 9 — the same screen with the coverage table explicitly sorted
    const sortHeader = page.getByRole("button", { name: /^Reviews done/ });
    await sortHeader.scrollIntoViewIfNeeded();
    await sortHeader.click();
    await expect(page.getByRole("columnheader", { name: /Reviews done/ })).toHaveAttribute("aria-sort", /ascending|descending/);
    await shoot(page, "evaluation-coverage.png", { access: "ADMIN" });

    // 11 — agenda Day grid with the unscheduled backlog strip
    await page.goto("/admin/agenda");
    await expect(page.getByText("Unscheduled backlog")).toBeVisible();
    await shoot(page, "agenda-day.png", { access: "ADMIN" });

    // 12 — a real server refusal. The seeded programme keeps Hall A occupied at
    //      10:00 on 12 May (verified in lib/demo/seed.ts), so this placement is
    //      refused and nothing is written.
    const backlogItem = page.locator(".card > div").filter({ hasText: "Unscheduled backlog" })
      .getByRole("button").first();
    await backlogItem.click();
    const scheduleDialog = page.getByRole("dialog");
    await scheduleDialog.getByRole("textbox", { name: "Date" }).fill("2026-05-12");
    await scheduleDialog.getByRole("textbox", { name: /^Start time/ }).fill("10:00");
    // By accessible name: the room `<label>` wraps its `<select>`, so its text
    // content is "Room" plus every option label.
    await scheduleDialog.getByRole("combobox", { name: "Room", exact: true }).selectOption({ label: "Hall A" });
    await scheduleDialog.getByRole("button", { name: "Schedule", exact: true }).click();
    await expect(scheduleDialog.getByRole("alert")).toContainText("This placement conflicts with an existing slot.");
    await shoot(page, "agenda-conflict-refusal.png", { access: "ADMIN", fullPage: false });
    await scheduleDialog.getByRole("button", { name: "Cancel" }).click();

    // 13 — assisted placement preview, which saves nothing
    await page.getByRole("button", { name: /^Fill open slots/ }).click();
    const previewDialog = page.getByRole("dialog");
    await expect(previewDialog.getByText("Fill open slots — nothing saved yet")).toBeVisible();
    await shoot(page, "agenda-fill-open-slots.png", { access: "ADMIN", fullPage: false });
    // Last, not first: the dialog also carries an icon-only "Close" in its header.
    await previewDialog.getByRole("button", { name: /^(Discard|Close)$/ }).last().click();

    // 16 — speaker readiness chase list
    await page.goto("/admin/speakers");
    await expect(page.getByRole("heading", { name: /Speaker/ }).first()).toBeVisible();
    await shoot(page, "admin-speakers.png", { access: "ADMIN" });

    // 17 — email history, populated by the receipt the beforeAll submission minted
    await page.goto("/admin/emails");
    await expect(page.getByRole("table")).toBeVisible();
    await shoot(page, "admin-emails.png", { access: "ADMIN" });

    // 21 — embed configuration
    await page.goto("/admin/embeds");
    await expect(page.getByText("<iframe").first()).toBeVisible();
    await shoot(page, "admin-embeds.png", { access: "ADMIN" });

    // 22 — decision mail: Send it stays disabled until Preview email has run
    await page.goto("/admin/operations");
    const sendIt = page.getByRole("button", { name: /Send it/ });
    await sendIt.scrollIntoViewIfNeeded();
    await expect(sendIt).toBeDisabled();
    await shoot(page, "admin-operations.png", { access: "ADMIN" });

    await context.close();
  });

  test("reviewer workspace", async ({ browser }) => {
    const context = await browser.newContext({ viewport: DESKTOP });
    const page = await context.newPage();
    await signInAs(page, "evaluator");

    // 10 — the reviewer's own queue, rubric scoring, Declare a conflict
    await expect(page.getByRole("button", { name: /Declare a conflict/ }).first()).toBeVisible();
    await shoot(page, "evaluator-workspace.png", { access: "EVALUATOR" });

    await context.close();
  });

  test("speaker surfaces", async ({ browser }) => {
    const context = await browser.newContext({ viewport: DESKTOP });
    const page = await context.newPage();
    await signInAs(page, "speaker");

    // 14 — the portal: completeness, confirmed sessions, the task checklist
    await expect(page.getByRole("heading", { name: "Your tasks" })).toBeVisible();
    await shoot(page, "speaker-portal.png", { access: "SPEAKER" });

    // 15 — a form-carrying task. The conditional questions only exist once the
    //      first answer makes them relevant, so the answer is given here (and
    //      never saved) rather than staged in the seed.
    await page
      .locator("li")
      .filter({ hasText: "Claim your flight reimbursement" })
      .getByRole("link", { name: /Fill in the form|Review your answers/ })
      .click();
    await page.waitForURL(/\/portal\/tasks\/[^/]+$/);
    await page.getByLabel("Are you claiming travel costs?").selectOption({ label: "Yes" });
    await expect(page.getByLabel("Departure city")).toBeVisible();
    await expect(page.getByRole("button", { name: /Save and mark done/ })).toBeVisible();
    await shoot(page, "speaker-task-form.png", { access: "SPEAKER" });

    await context.close();
  });
});
