/**
 * The judge journey, driven end to end in a real browser (D-C5-15 item 1).
 *
 * This is the one artifact that proves the golden path as a JUDGE experiences
 * it: a real Chromium, against a real production build (`next build` +
 * `next start`), against a real Postgres seeded by `npm run db:seed`. Nothing
 * is stubbed and no API is called directly — every assertion below is about
 * something a person could see and click.
 *
 * Order is the point, so the whole journey is one test with named steps: each
 * step depends on the state the previous one left behind, and a step that fails
 * screenshots itself before it rethrows.
 *
 * Re-runnable by construction: the suite reseeds in `beforeAll` (the seed wipes
 * and rebuilds all event-scoped data) and the proposal title carries a
 * per-run timestamp, so a second run is not disturbed by the first.
 *
 * ⚠️ This suite WRITES. See `e2e/README.md` and `e2e/db-guard.ts`.
 */
import { expect, test } from "@playwright/test";
import { escapeRegExp, expectLoggedOut, guardAndReseed, journeyStep, signInAs, signOut } from "./harness";

/**
 * Seeded geometry this journey depends on, verified against `lib/demo/seed.ts`
 * rather than taken from the walkthrough script:
 *
 * - `demoSchedulePlan()` places session index 1 in `hall-a` at `SLOT_HOURS[1]`
 *   (10:00) on `SCHEDULE_DAYS[0]` (2026-05-12), so Hall A at 10:00 on 12 May is
 *   OCCUPIED. (Note: the occupant is the first accepted proposal, not the
 *   keynote — the keynote is in the Grand Ballroom at 09:00 that day. The
 *   VIDEO-SCRIPT's "vs the seeded keynote" phrasing is loose; the refusal is
 *   the same either way.)
 * - Only one placement lands on the last day (2026-05-14) and it is in `hall-b`
 *   at 13:00, so the Grand Ballroom at 10:00 on 14 May is FREE.
 *
 * `lib/demo/seed-invariants.test.ts` pins both facts, so a seed change that
 * broke this journey fails the unit suite first.
 */
const OCCUPIED = { date: "2026-05-12", time: "10:00", room: "Hall A" } as const;
const FREE = { date: "2026-05-14", time: "10:00", room: "Grand Ballroom" } as const;

const SEEDED_KEYNOTE = "Opening Keynote: The Next Decade of Developer Experience";

const STAMP = Date.now();
const TITLE = `Backstage: Running a 3,000-Person Conference [e2e ${STAMP}]`;
const TITLE_RE = new RegExp(escapeRegExp(TITLE));
const SPEAKER_NAME = "Robin Vance";
const SPEAKER_EMAIL = `robin.vance.${STAMP}@speakers.demo`;

test.describe("golden path", () => {
  test.beforeAll(() => {
    guardAndReseed();
  });

  test("a proposal travels from the public CFP to the published programme", async ({ page }) => {
    await journeyStep(page, "a. the public call for speakers renders to nobody", async () => {
      await page.goto("/cfp/forward-2026/call-for-speakers");
      await expect(page.getByRole("heading", { name: "2026 Call for Speakers" })).toBeVisible();
      await expect(page.getByText("Pitch your talk below.")).toBeVisible();
      await expectLoggedOut(page);
    });

    await journeyStep(page, "b. a speaker submits a proposal through the real form", async () => {
      await page.getByRole("button", { name: "Next", exact: true }).click();

      await page.getByLabel("Session title").fill(TITLE);
      await page
        .getByLabel("Abstract")
        .fill(
          "What actually breaks when a conference outgrows a spreadsheet: the programme, "
            + "the speaker chase list, and the schedule. Submitted by the browser-level golden-path proof.",
        );
      await page.getByLabel("Session format").selectOption({ label: "Talk (30 min)" });
      await page.getByLabel("Topic category").selectOption({ index: 1 });
      await page.getByLabel("Audience level").selectOption({ label: "Intermediate" });
      await page
        .getByLabel("What will attendees learn?")
        .fill("1) Where a spreadsheet stops scaling. 2) What to automate first. 3) A checklist to take home.");
      await page.getByLabel("I agree to the code of conduct").check();
      await page.getByRole("button", { name: "Next", exact: true }).click();

      await page.getByLabel("Full name (primary)").fill(SPEAKER_NAME);
      await page.getByLabel("Email").fill(SPEAKER_EMAIL);
      await page.getByRole("button", { name: "Next", exact: true }).click();

      // The review step must echo back what will be sent.
      await expect(page.getByRole("heading", { name: "Review & submit" })).toBeVisible();
      await expect(page.getByText(TITLE_RE)).toBeVisible();

      await page.getByRole("button", { name: "Submit proposal" }).click();
      await expect(page.getByRole("heading", { name: "Submission received" })).toBeVisible();
      await expectLoggedOut(page);
    });

    await journeyStep(page, "c. the organizer signs in", async () => {
      await signInAs(page, "admin");
      await expect(page.getByRole("button", { name: "Sign out" }).first()).toBeVisible();
    });

    await journeyStep(page, "d. the proposal is in the pipeline and opens", async () => {
      await page.goto("/admin/abstracts");
      await page.getByLabel("Search abstracts").fill(String(STAMP));

      const row = page.getByRole("row").filter({ hasText: TITLE });
      await expect(row).toHaveCount(1);
      await row.getByRole("button", { name: `View ${TITLE}` }).click();

      const drawer = page.getByRole("dialog");
      await expect(drawer.getByRole("heading", { name: TITLE })).toBeVisible();
      // The organizer sees the custom answers under their own question labels.
      await expect(drawer.getByText("What will attendees learn?")).toBeVisible();
      await expect(drawer.getByText("No talk created yet")).toBeVisible();
    });

    await journeyStep(page, "e. accepting provisions the session and the onboarding tasks", async () => {
      const drawer = page.getByRole("dialog");

      // The server's own confirmation of what acceptance built. Captured from
      // the real response the page received, not from a separate API call.
      const decision = page.waitForResponse(
        (res) => res.url().includes("/api/evaluations/decisions") && res.request().method() === "POST",
      );
      await drawer.getByRole("button", { name: "Accept", exact: true }).click();
      const body = (await (await decision).json()) as {
        data?: { sessionCreated?: boolean; tasksAssigned?: number; session?: { title?: string } | null };
      };
      expect(body.data?.sessionCreated, "acceptance created the confirmed session").toBe(true);
      expect(body.data?.tasksAssigned ?? 0, "acceptance assigned onboarding tasks").toBeGreaterThan(0);
      expect(body.data?.session?.title).toBe(TITLE);

      // And what the organizer is actually shown afterwards.
      await expect(drawer.getByText("Accepted.", { exact: true })).toBeVisible();
      await expect(drawer.getByText("Talk created, not scheduled")).toBeVisible();
      await expect(drawer.getByText("Talk created — schedule it in the agenda builder.")).toBeVisible();

      await drawer.getByRole("button", { name: "Close" }).click();
    });

    await journeyStep(page, "f. a colliding placement is refused by the server", async () => {
      await page.goto("/admin/agenda");
      await expect(page.getByText("Unscheduled backlog")).toBeVisible();
      await page.getByRole("button", { name: TITLE_RE }).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("Schedule session")).toBeVisible();
      await dialog.getByRole("textbox", { name: "Date" }).fill(OCCUPIED.date);
      await dialog.getByRole("textbox", { name: /^Start time/ }).fill(OCCUPIED.time);
      // By accessible name, not by label text: the room `<label>` wraps its own
      // `<select>`, so its text content is "Room" plus every option label.
      await dialog.getByRole("combobox", { name: "Room", exact: true }).selectOption({ label: OCCUPIED.room });
      await dialog.getByRole("button", { name: "Schedule", exact: true }).click();

      const refusal = dialog.getByRole("alert");
      await expect(refusal).toContainText("This placement conflicts with an existing slot.");
      await expect(refusal).toContainText("Room is already booked for an overlapping time.");
      // Refused means refused: the dialog is still open and nothing was written.
      await expect(dialog).toBeVisible();
    });

    await journeyStep(page, "g. a free placement lands", async () => {
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("textbox", { name: "Date" }).fill(FREE.date);
      await dialog.getByRole("textbox", { name: /^Start time/ }).fill(FREE.time);
      await dialog.getByRole("combobox", { name: "Room", exact: true }).selectOption({ label: FREE.room });
      await dialog.getByRole("button", { name: "Schedule", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // Off the backlog, onto the programme, in the room and time we asked for.
      await page.getByRole("button", { name: "List" }).click();
      const listed = page.locator(".agenda-list-item").filter({ hasText: TITLE });
      await expect(listed).toHaveCount(1);
      await expect(listed).toContainText(FREE.room);
      await expect(listed).toContainText(SPEAKER_NAME);
    });

    await journeyStep(page, "h. the speaker portal renders with its tasks", async () => {
      await signOut(page);
      await signInAs(page, "speaker");
      await expect(page.getByRole("heading", { name: "Welcome back, Sofia" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Your tasks" })).toBeVisible();
      await expect(page.getByText("Claim your flight reimbursement")).toBeVisible();
      await expect(page.getByText("Tell us about your hotel stay")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Your sessions" })).toBeVisible();
    });

    await journeyStep(page, "i. the public programme is readable with no login at all", async () => {
      await signOut(page);
      await page.context().clearCookies();
      await page.goto("/schedule");
      await expectLoggedOut(page);
      await expect(page.getByText(SEEDED_KEYNOTE)).toBeVisible();
      // Including the talk this journey just put on the programme.
      await expect(page.getByText(TITLE_RE).first()).toBeVisible();
    });
  });
});
