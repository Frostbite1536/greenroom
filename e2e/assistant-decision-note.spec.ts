import { createServer, type Server } from "node:http";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { guardAndReseed, journeyStep, signInAs } from "./harness";
import { E2E_ASSISTANT_STUB_PORT } from "../playwright.config";

/**
 * Browser proof for decision-note drafting.
 *
 * The provider call happens in the Next server process, so `page.route` cannot
 * reach it. Instead this spec runs a loopback stub and the config points the
 * server at it through the fenced `ASSISTANT_ENDPOINT_OVERRIDE` seam — honoured
 * only for an explicit loopback URL, only with `MOCK_EXTERNAL_APIS` exactly
 * `"true"`, and never on a deployed production runtime. Nothing in the page is
 * stubbed; the only thing replaced is the third party.
 *
 * The stub is also an assertion point no unit test can reach: it captures the
 * real outbound request the real server built, so the projection claim ("only
 * event name, title, decision, and the chosen comments leave") is proven
 * against the wire rather than against a function's return value.
 *
 * BUDGET, and why the generation count here is deliberately small: every one of
 * these clicks is charged against the real durable throttle, which allows FIVE
 * per admin per minute (`ASSISTANT_RATE_LIMITS.assistantAdminMinute`). All three
 * tests share one persona, so the suite has exactly five generations and a
 * sixth would start refusing with "Too many draft requests" — which is the
 * throttle working, but would read as a flake. Add coverage as unit tests, not
 * as more clicks.
 */

const MOBILE = { width: 390, height: 664 } as const;

const OPERATIONS = "/admin/operations";
const DRAFT_BUTTON = "Draft note from feedback";
const STUB_DRAFT =
  "Your session stood out for how concretely it treats the day-to-day of running a large event, and the program team is glad to have it.";
const MANUAL_NOTE = "A note I wrote myself before asking for any help.";
const EDITED_NOTE = "A note I wrote myself, then edited by hand.";

/** What the stub should do next. Swapped per test. */
type StubMode = "success" | "server-error" | "slow";
let stubMode: StubMode = "success";
/** Every request body the server actually sent, newest last. */
let stubRequests: Array<Record<string, unknown>> = [];
let stubAuthorizations: string[] = [];
let stub: Server;

/** Long enough to switch proposals before the answer lands, short enough to wait on. */
const SLOW_RESPONSE_MS = 2_000;

/**
 * A Responses answer carrying this feature's strict `{draft}` schema.
 *
 * The contract an external loopback fixture has to satisfy is exactly this:
 * dispatch on the strict schema name in the request's `text.format`, answer
 * with one `output_text` part whose content is `{"draft": "..."}`. Kept
 * deliberately minimal so swapping this listener for a shared owned provider is
 * a change of transport, not of contract.
 */
function successPayload(): Record<string, unknown> {
  return {
    id: "resp_e2e",
    status: "completed",
    model: "gpt-5-mini-e2e",
    output: [
      // A reasoning item first, exactly as a reasoning model answers, so the
      // extractor is exercised rather than handed output[0].
      { id: "rs_e2e", type: "reasoning", summary: [] },
      {
        id: "msg_e2e",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify({ draft: STUB_DRAFT }), annotations: [] }],
      },
    ],
    usage: { input_tokens: 210, output_tokens: 48 },
  };
}

function stubBody(): Record<string, unknown> {
  expect(stubRequests.length, "the server must have called the provider").toBeGreaterThan(0);
  return stubRequests[stubRequests.length - 1]!;
}

/** The `input` string the server sent — the DATA block, verbatim. */
function stubPrompt(): string {
  return String(stubBody().input ?? "");
}

test.describe.configure({ mode: "serial" });

test.describe("decision-note drafting", () => {
  test.beforeAll(async () => {
    guardAndReseed();
    stub = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        try {
          stubRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        } catch {
          stubRequests.push({});
        }
        stubAuthorizations.push(String(req.headers.authorization ?? ""));

        if (stubMode === "server-error") {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("stub failure");
          return;
        }
        // Held open long enough for the organizer to move to another proposal
        // before this answer lands. The point of the race test is that it DOES
        // land, and is thrown away.
        if (stubMode === "slow") {
          setTimeout(() => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(successPayload()));
          }, SLOW_RESPONSE_MS);
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(successPayload()));
      });
    });
    await new Promise<void>((resolve) => stub.listen(E2E_ASSISTANT_STUB_PORT, "127.0.0.1", resolve));
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  });

  test.beforeEach(() => {
    stubMode = "success";
    stubRequests = [];
    stubAuthorizations = [];
  });

  const panelOf = (page: Page) => page.getByRole("region", { name: "Tell a speaker your decision" });
  /** The rendered email, so an assertion about it cannot match the textarea. */
  const emailPreview = (page: Page) => panelOf(page).getByRole("group", { name: "Email preview" });

  // Runs first, on a fresh throttle budget for the shared admin persona.
  test("the whole affordance works and does not break the layout at 390px", async ({ browser }) => {
    const page = await mobilePage(browser);
    try {
      await signInAs(page, "admin");
      await page.goto(OPERATIONS);
      const panel = panelOf(page);
      const note = panel.getByLabel("Add a personal note (optional)");
      const button = panel.getByRole("button", { name: DRAFT_BUTTON });

      await expect(button).toBeVisible();
      await expect(note).toBeVisible();

      // No horizontal overflow: that is what a broken narrow layout looks like.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);

      // The control is inside the viewport and big enough to hit.
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(MOBILE.width + 1);
      expect(box!.height).toBeGreaterThanOrEqual(24);

      // Generation 1 of 5. The full generate -> apply path at this width.
      await button.click();
      await expect(panel.getByText("Suggested draft")).toBeVisible();
      await expect(panel.getByText(STUB_DRAFT)).toBeVisible();
      await panel.getByRole("button", { name: "Use this note" }).click();
      await expect(note).toHaveValue(STUB_DRAFT);

      const afterOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(afterOverflow).toBeLessThanOrEqual(1);
    } finally {
      await page.context().close();
    }
  });

  test("generate, apply, edit, and the preview gate still demands the exact content", async ({ page }) => {
    const panel = () => panelOf(page);
    const note = () => panel().getByLabel("Add a personal note (optional)");

    await journeyStep(page, "a. an admin reaches a populated decisions panel", async () => {
      await signInAs(page, "admin");
      await page.goto(OPERATIONS);
      await expect(page.getByRole("heading", { name: "Tell a speaker your decision" })).toBeVisible();
      await expect(panel().getByText("No proposals have been accepted or declined yet.")).toHaveCount(0);
      await expect(panel().getByRole("button", { name: DRAFT_BUTTON })).toBeVisible();
      // The disclosure is readable before anything is sent.
      await expect(panel().getByText(/to the configured AI provider/)).toBeVisible();
      // The truthful disclosure, both halves: what is never added as a field,
      // and that comment text itself travels word for word.
      await expect(panel().getByText(/is looked up or added as a separate field/)).toBeVisible();
      await expect(panel().getByText(/Reviewer comments are sent word for word/)).toBeVisible();
    });

    await journeyStep(page, "b. generating produces a labelled suggestion, not a filled field", async () => {
      // Generation 2 of 5.
      const seen = page.waitForResponse((res) => res.url().includes("/api/assistant/decision-note"));
      await panel().getByRole("button", { name: DRAFT_BUTTON }).click();
      const response = await seen;
      // A generated note is per-organizer and derived from reviewer comments,
      // so nothing between the server and the page may keep a copy.
      expect(response.headers()["cache-control"]).toBe("no-store");
      await expect(panel().getByText("Suggested draft")).toBeVisible();
      await expect(panel().getByText("Generated by AI — read it before you use it.")).toBeVisible();
      await expect(panel().getByText(STUB_DRAFT)).toBeVisible();
      // The grounding names what it was built from.
      await expect(panel().getByText(/Based on \d+ reviewer comments?/)).toBeVisible();
      // The suggestion is NOT the note: the field is still empty.
      await expect(note()).toHaveValue("");
    });

    await journeyStep(page, "c. the outbound request carried only the four allowed facts", async () => {
      const prompt = stubPrompt();
      // Positive: the projection really is there, so this is not vacuous.
      expect(prompt).toContain("-----BEGIN DATA-----");
      expect(prompt).toMatch(/^event_name: .+$/m);
      expect(prompt).toMatch(/^proposal_title: .+$/m);
      expect(prompt).toMatch(/^decision: (accepted|declined)$/m);

      // The CLOSED projection: exactly these field names, nothing else, ever.
      // This is the real guarantee. An earlier version asserted the prompt held
      // no "@" — which passed only because this seed's comments happen to
      // contain no address, and would have gone green while leaking one the day
      // a reviewer typed it. The honest claim is about the field set, not about
      // what the seed's free text happens to say.
      const keys = [...prompt.matchAll(/^([a-z_0-9]+):/gm)].map(([, key]) => key);
      expect(keys.length).toBeGreaterThan(2);
      for (const key of keys) {
        expect(key).toMatch(/^(event_name|proposal_title|decision|reviewer_comment_\d+)$/);
      }
      // No identifier the handler had in scope reached the wire.
      expect(prompt).not.toMatch(/\bcm[a-z0-9]{20,}\b/);

      // Non-retention, no tools, and the code-owned strict schema, asserted on
      // the body the server really sent.
      const body = stubBody();
      expect(body.store).toBe(false);
      expect(body).not.toHaveProperty("tools");
      expect(body).not.toHaveProperty("stream");
      expect(body.text).toEqual({
        format: {
          type: "json_schema",
          name: "greenroom_decision_note",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["draft"],
            properties: { draft: { type: "string" } },
          },
        },
      });
      // The fake key went to the stub; a real credential never left the config.
      expect(stubAuthorizations[0]).toContain("sk-e2e-local-only");
    });


    await journeyStep(page, "d. applying is explicit, and consumes the suggestion", async () => {
      await panel().getByRole("button", { name: "Use this note" }).click();
      await expect(note()).toHaveValue(STUB_DRAFT);
      await expect(panel().getByText("Suggested draft")).toHaveCount(0);
    });

    await journeyStep(page, "e. the applied draft previews, and Send unlocks only then", async () => {
      await expect(panel().getByRole("button", { name: "Send it" })).toBeDisabled();
      await panel().getByRole("button", { name: "Preview email" }).click();
      await expect(panel().getByText(/^Preview for /)).toBeVisible();
      await expect(emailPreview(page)).toContainText(STUB_DRAFT);
      await expect(panel().getByRole("button", { name: "Send it" })).toBeEnabled();
    });

    await journeyStep(page, "f. editing the applied text re-locks Send until it is previewed again", async () => {
      await note().fill(EDITED_NOTE);
      await expect(panel().getByText(/^Preview for /)).toHaveCount(0);
      await expect(panel().getByRole("button", { name: "Send it" })).toBeDisabled();
      await expect(panel().getByText("Preview first")).toBeVisible();

      await panel().getByRole("button", { name: "Preview email" }).click();
      await expect(panel().getByText(/^Preview for /)).toBeVisible();
      await expect(emailPreview(page)).toContainText(EDITED_NOTE);
      await expect(panel().getByRole("button", { name: "Send it" })).toBeEnabled();
    });

    await journeyStep(page, "g. a suggestion never overwrites written text without consent", async () => {
      // Generation 3 of 5.
      await panel().getByRole("button", { name: DRAFT_BUTTON }).click();
      await expect(panel().getByText("Suggested draft")).toBeVisible();
      // The organizer's edited text is untouched by the arrival of a suggestion.
      await expect(note()).toHaveValue(EDITED_NOTE);

      // The control now names replacement, and asks before doing it.
      await panel().getByRole("button", { name: "Replace my note" }).click();
      await expect(panel().getByText(/replace the note you have already written/)).toBeVisible();
      await expect(note()).toHaveValue(EDITED_NOTE);

      // Backing out keeps what was written, and the suggestion survives.
      await panel().getByRole("button", { name: "Keep what I wrote" }).click();
      await expect(note()).toHaveValue(EDITED_NOTE);
      await expect(panel().getByText("Suggested draft")).toBeVisible();

      // Confirming replaces it, and invalidates the preview of the old text.
      await panel().getByRole("button", { name: "Replace my note" }).click();
      await panel().getByRole("button", { name: "Yes, replace my note" }).click();
      await expect(note()).toHaveValue(STUB_DRAFT);
      await expect(panel().getByText(/^Preview for /)).toHaveCount(0);
      await expect(panel().getByRole("button", { name: "Send it" })).toBeDisabled();
    });
  });

  test("a draft for an abandoned proposal never installs under the newly-selected one", async ({ page }) => {
    const panel = () => panelOf(page);
    const note = () => panel().getByLabel("Add a personal note (optional)");

    await signInAs(page, "admin");
    await page.goto(OPERATIONS);

    const select = panel().getByLabel("Proposal");
    const options = await select.locator("option").all();
    expect(options.length, "the race needs two proposals to switch between").toBeGreaterThan(1);
    const firstValue = await options[0]!.getAttribute("value");
    const secondValue = await options[1]!.getAttribute("value");

    await journeyStep(page, "the abandoned response lands and is thrown away", async () => {
      await select.selectOption(firstValue!);
      await note().fill(MANUAL_NOTE);

      stubMode = "slow";
      const landed = page.waitForResponse((res) => res.url().includes("/api/assistant/decision-note"));
      // Generation 4 of 5.
      await panel().getByRole("button", { name: DRAFT_BUTTON }).click();

      // Switch proposals while the first request is still open.
      await select.selectOption(secondValue!);
      await expect(panel().getByText("Suggested draft")).toHaveCount(0);

      // The response for the ABANDONED proposal really does arrive — this is
      // not a test that the request was cancelled, but that its answer was
      // refused installation.
      const response = await landed;
      expect(response.status()).toBe(200);
      expect(stubRequests.length).toBe(1);

      // Nothing installed, and nothing is appliable. Give the panel a real
      // window to get it wrong before concluding it did not.
      await page.waitForTimeout(1_000);
      await expect(panel().getByText("Suggested draft")).toHaveCount(0);
      await expect(panel().getByText(STUB_DRAFT)).toHaveCount(0);
      await expect(panel().getByRole("button", { name: "Use this note" })).toHaveCount(0);
      await expect(panel().getByRole("button", { name: "Replace my note" })).toHaveCount(0);
      // And it did not surface as an error either — the organizer abandoned it.
      await expect(panel().getByText("Drafting unavailable")).toHaveCount(0);
      // The organizer's own text is untouched throughout.
      await expect(note()).toHaveValue(MANUAL_NOTE);
    });
  });

  test("a failing provider refuses honestly and leaves the organizer's note alone", async ({ page }) => {
    const panel = () => panelOf(page);
    const note = () => panel().getByLabel("Add a personal note (optional)");

    await signInAs(page, "admin");
    await page.goto(OPERATIONS);
    await note().fill(MANUAL_NOTE);

    await journeyStep(page, "a provider 500 becomes an honest unavailable state", async () => {
      stubMode = "server-error";
      const refusal = page.waitForResponse(
        (res) => res.url().includes("/api/assistant/decision-note") && res.request().method() === "POST",
      );
      // Generation 5 of 5.
      await panel().getByRole("button", { name: DRAFT_BUTTON }).click();
      const response = await refusal;

      // A real failure status, not a 200 carrying an apology.
      expect(response.status()).toBe(502);
      const envelope = (await response.json()) as { ok: boolean; error: { code: string; message: string } };
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe("ASSISTANT_UNAVAILABLE");
      // The refusal names no provider internals.
      expect(envelope.error.message).not.toMatch(/openai|gpt|stub failure|500/i);

      const status = panel().getByRole("status").filter({ hasText: "Drafting unavailable" });
      await expect(status).toBeVisible();
      await expect(status).toContainText(/write the note yourself/i);
      // Nothing was invented to paper over the failure.
      await expect(panel().getByText("Suggested draft")).toHaveCount(0);
      // And the organizer's own paragraph survived it.
      await expect(note()).toHaveValue(MANUAL_NOTE);
      await expect(note()).toBeEnabled();
      // The 5xx bought exactly one retry, inside the single request.
      expect(stubRequests.length).toBe(2);
    });

    await journeyStep(page, "the deterministic send path is untouched by the failure", async () => {
      await panel().getByRole("button", { name: "Preview email" }).click();
      await expect(panel().getByText(/^Preview for /)).toBeVisible();
      await expect(emailPreview(page)).toContainText(MANUAL_NOTE);
      await expect(panel().getByRole("button", { name: "Send it" })).toBeEnabled();
    });
  });
});

/** A 390x664 context, following the pattern in `screenshots.spec.ts`. */
async function mobilePage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: MOBILE });
  return context.newPage();
}
