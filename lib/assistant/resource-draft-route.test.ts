import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ApiError } from "@/lib/api/http";
import {
  createResourceDraftPost,
  type ResourceDraftRouteDependencies,
} from "@/app/api/assistant/resource-draft/route";
import type { ResourceDraftRequest, ResourceDraftSuggestion } from "./resource-draft";

const body: ResourceDraftRequest = {
  templateKey: "speaker-handbook",
  title: "Speaker handbook",
  summary: "Presenter guidance.",
  notes: "Slides are due Friday.",
};

const suggestion: ResourceDraftSuggestion = {
  html: "<h2>Welcome, speakers</h2><p>Slides are due Friday.</p><p>[Add check-in time]</p>",
  templateKey: "speaker-handbook",
  sectionsUsed: ["welcome", "key-dates", "before-arrival", "presentation", "help"],
  placeholders: ["[Add check-in time]"],
};

type Recorder = {
  calls: string[];
  rateInputs: Array<{ userId: string; eventId: string }>;
  generatedInputs: ResourceDraftRequest[];
};

function dependencies(
  overrides: Partial<ResourceDraftRouteDependencies> = {},
): { dependencies: ResourceDraftRouteDependencies; recorder: Recorder } {
  const recorder: Recorder = { calls: [], rateInputs: [], generatedInputs: [] };
  return {
    recorder,
    dependencies: {
      requireAdmin: async () => {
        recorder.calls.push("auth");
        return { userId: "admin-1", eventId: "event-from-session" };
      },
      enforceRate: async (input) => {
        recorder.calls.push("rate");
        recorder.rateInputs.push(input);
      },
      generate: async (input) => {
        recorder.calls.push("generate");
        recorder.generatedInputs.push(input);
        return { ok: true, suggestion };
      },
      ...overrides,
    },
  };
}

function request(value: unknown = body, headers?: Record<string, string>): Request {
  return new Request("http://127.0.0.1:3414/api/assistant/resource-draft", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(value),
  });
}

async function responseBody(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

test("success is ADMIN-context scoped, metered before generation, and no-store", async () => {
  const fixture = dependencies();
  const response = await createResourceDraftPost(fixture.dependencies)(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await responseBody(response), { ok: true, data: { suggestion } });
  assert.deepEqual(fixture.recorder.calls, ["auth", "rate", "generate"]);
  assert.deepEqual(fixture.recorder.rateInputs, [{ userId: "admin-1", eventId: "event-from-session" }]);
  assert.deepEqual(fixture.recorder.generatedInputs, [body]);
});

test("401 and 403 stop before body, rate accounting, and provider generation", async () => {
  for (const [status, code] of [[401, "UNAUTHENTICATED"], [403, "FORBIDDEN"]] as const) {
    const fixture = dependencies({
      requireAdmin: async () => {
        fixture.recorder.calls.push("auth");
        throw new ApiError(status, code, "refused");
      },
    });
    const response = await createResourceDraftPost(fixture.dependencies)(request());
    assert.equal(response.status, status);
    assert.deepEqual(fixture.recorder.calls, ["auth"]);
    assert.equal((await responseBody(response)).error.code, code);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
});

test("strict bounds reject caller event scope and oversized bodies before cost or provider", async () => {
  const fixture = dependencies();
  const smuggled = await createResourceDraftPost(fixture.dependencies)(request({ ...body, eventId: "other-event" }));
  assert.equal(smuggled.status, 422);
  assert.equal((await responseBody(smuggled)).error.code, "VALIDATION_ERROR");
  assert.deepEqual(fixture.recorder.calls, ["auth"]);

  const oversizedFixture = dependencies();
  const oversized = await createResourceDraftPost(oversizedFixture.dependencies)(
    request(body, { "Content-Length": String(41 * 1_024) }),
  );
  assert.equal(oversized.status, 413);
  assert.equal((await responseBody(oversized)).error.code, "REQUEST_TOO_LARGE");
  assert.deepEqual(oversizedFixture.recorder.calls, ["auth"]);
});

test("durable rate refusals retain their 429 and Retry-After contract", async () => {
  const fixture = dependencies({
    enforceRate: async () => {
      fixture.recorder.calls.push("rate");
      throw new ApiError(429, "ASSISTANT_RATE_LIMITED", "Try again shortly.", undefined, 37);
    },
  });
  const response = await createResourceDraftPost(fixture.dependencies)(request());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "37");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal((await responseBody(response)).error.code, "ASSISTANT_RATE_LIMITED");
  assert.deepEqual(fixture.recorder.calls, ["auth", "rate"]);
});

test("provider failures have stable copy and never expose raw prompts, output, or errors", async () => {
  const expected = {
    disabled: [503, "ASSISTANT_DISABLED"],
    timeout: [504, "ASSISTANT_TIMEOUT"],
    rate_limited: [503, "ASSISTANT_PROVIDER_RATE_LIMITED"],
    provider_error: [502, "ASSISTANT_PROVIDER_ERROR"],
    invalid_output: [502, "ASSISTANT_INVALID_OUTPUT"],
  } as const;
  for (const [reason, [status, code]] of Object.entries(expected) as Array<
    [keyof typeof expected, (typeof expected)[keyof typeof expected]]
  >) {
    const fixture = dependencies({ generate: async () => ({ ok: false, reason }) });
    const response = await createResourceDraftPost(fixture.dependencies)(request());
    const responseText = await response.text();
    assert.equal(response.status, status, reason);
    assert.match(responseText, new RegExp(code));
    assert.doesNotMatch(responseText, /Slides are due|hunter2|stack|OpenAI|raw/i);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
});

test("the production route has no event-data reader, caller eventId, second provider, or write path", () => {
  const source = readFileSync(
    new URL("../../app/api/assistant/resource-draft/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /requireContext\(\["ADMIN"\]\)/);
  assert.match(source, /parseBoundedJson\(req, RESOURCE_DRAFT_BODY_MAX_BYTES\)/);
  assert.match(source, /enforceAssistantRateLimit/);
  assert.match(source, /generateResourceDraft/);
  assert.ok(source.indexOf("requireAdmin()") < source.indexOf("parseBoundedJson("));
  assert.ok(source.indexOf("parseBoundedJson(") < source.indexOf("enforceRate("));
  assert.ok(source.indexOf("enforceRate(") < source.indexOf("generate("));
  assert.doesNotMatch(source, /\bprisma\b|ResourceWiki|Abstract|Reviewer|Session|Speaker|fetch\(|OPENAI_API_KEY/);
  assert.doesNotMatch(source, /input\.eventId|body\.eventId|req\.eventId/);
  assert.match(source, /ctx\.eventId/);
});
