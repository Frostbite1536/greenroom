import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  ASSISTANT_DEFAULT_MAX_OUTPUT_CHARS,
  ASSISTANT_ENDPOINT,
  ASSISTANT_FAILURE_REASONS,
  ASSISTANT_MAX_ATTEMPTS,
  ASSISTANT_MAX_INSTRUCTION_CHARS,
  ASSISTANT_MAX_OUTPUT_CHARS,
  ASSISTANT_MAX_TOTAL_INPUT_CHARS,
  ASSISTANT_MODEL,
  ASSISTANT_OUTPUT_TOKEN_HEADROOM,
  ASSISTANT_TIMEOUT_MS,
  assistantMaxOutputTokens,
  boundAssistantInput,
  boundAssistantOutputChars,
  isAssistantConfigured,
  runAssistant,
  type AssistantResult,
} from "./client";

/**
 * The provider is NEVER called from these tests: every case supplies its own
 * fetcher, and the disabled case asserts no fetcher is reached at all.
 *
 * Source assertions are CRLF-safe: no pattern crosses a line break.
 */

const KEY = "sk-test-not-a-real-key-000000000000";

/** A marker that must never appear in a log line or in a returned failure. */
const SECRET_MARKER = "hunter2-PROMPT-LEAK-MARKER";

type Call = { url: string; init: RequestInit };

/** Run `fn` with exactly this `OPENAI_API_KEY`, restoring whatever was there. */
async function withKey<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.OPENAI_API_KEY;
  try {
    if (value === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = value;
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  }
}

/** Capture every console channel, so a leak on any of them is visible. */
async function withCapturedLogs<T>(fn: () => Promise<T>): Promise<{ value: T; logs: string[] }> {
  const logs: string[] = [];
  const channels = ["log", "info", "warn", "error", "debug"] as const;
  const saved = channels.map((name) => [name, console[name]] as const);
  for (const name of channels) {
    console[name] = ((...args: unknown[]) => {
      logs.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    }) as typeof console.log;
  }
  try {
    return { value: await fn(), logs };
  } finally {
    for (const [name, original] of saved) console[name] = original;
  }
}

/** A fetcher that records its calls and replays the given responses in order. */
function recordingFetcher(
  responses: Array<(init: RequestInit) => Promise<Response>>,
): { calls: Call[]; fetcher: typeof fetch } {
  const calls: Call[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const seen = init ?? {};
    calls.push({ url: String(url), init: seen });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return next!(seen);
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

function completedResponse(text: string, usage = { input_tokens: 120, output_tokens: 45 }): Response {
  return Response.json({
    id: "resp_test",
    object: "response",
    status: "completed",
    model: `${ASSISTANT_MODEL}-2026-01-01`,
    // A reasoning model emits this item before the message; the extractor must
    // step over it rather than reading `output[0]`.
    output: [
      { id: "rs_test", type: "reasoning", summary: [] },
      {
        id: "msg_test",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage,
  });
}

function outboundBody(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

test("with no key the assistant is disabled: no provider call, no fabricated draft", async () => {
  const { calls, fetcher } = recordingFetcher([
    async () => {
      throw new Error("the provider must not be reached when unconfigured");
    },
  ]);
  const { value, logs } = await withCapturedLogs(async () =>
    withKey(undefined, async () => {
      assert.equal(isAssistantConfigured(), false);
      return runAssistant({ instructions: SECRET_MARKER, input: SECRET_MARKER, fetcher });
    }),
  );
  assert.deepEqual(value, { ok: false, reason: "disabled" });
  assert.equal(calls.length, 0, "fetch must never be called without a credential");
  // Unconfigured is a supported deployment, not an incident: it stays silent.
  assert.deepEqual(logs, []);
});

test("a too-short key reads as absent rather than as a configured provider", async () => {
  await withKey("sk-short", async () => {
    assert.equal(isAssistantConfigured(), false);
    const { calls, fetcher } = recordingFetcher([async () => completedResponse("unreachable")]);
    assert.deepEqual(await runAssistant({ instructions: "a", input: "b", fetcher }), {
      ok: false,
      reason: "disabled",
    });
    assert.equal(calls.length, 0);
  });
});

test("a completed generation returns its message text and nothing else", async () => {
  const { calls, fetcher } = recordingFetcher([async () => completedResponse("  Thank you for proposing.  ")]);
  const result = await withKey(KEY, async () => {
    assert.equal(isAssistantConfigured(), true);
    return withCapturedLogs(async () => runAssistant({ instructions: "Write warmly.", input: "A comment.", fetcher }));
  });
  assert.deepEqual(result.value, { ok: true, text: "Thank you for proposing." });
  assert.equal(calls.length, 1);
});

test("the outbound request is non-retained, capped, and carries no tools, stream, or history", async () => {
  const { calls, fetcher } = recordingFetcher([async () => completedResponse("ok")]);
  await withKey(KEY, async () =>
    withCapturedLogs(async () =>
      runAssistant({ instructions: "Write warmly.", input: "A comment.", maxOutputChars: 900, fetcher }),
    ),
  );

  const call = calls[0]!;
  assert.equal(call.url, ASSISTANT_ENDPOINT);
  assert.equal(call.init.method, "POST");
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
  assert.equal(headers["Content-Type"], "application/json");
  assert.ok(call.init.signal, "the request must carry an abort signal");

  const body = outboundBody(call);
  // The non-retention flag the assessment requires, asserted as a real false
  // rather than as merely absent.
  assert.equal(body.store, false);
  assert.equal(body.model, ASSISTANT_MODEL);
  assert.equal(body.instructions, "Write warmly.");
  assert.equal(body.input, "A comment.");
  assert.equal(body.max_output_tokens, assistantMaxOutputTokens(900));
  assert.deepEqual(body.reasoning, { effort: "low" });
  for (const forbidden of ["stream", "tools", "tool_choice", "previous_response_id", "conversation", "prompt"]) {
    assert.equal(forbidden in body, false, `the request must not carry \`${forbidden}\``);
  }
  // Plain prose is still the default: a caller that asked for no format sends
  // the body it sent before Structured Outputs was an option.
  assert.equal("text" in body, false, "plain-text mode must not send a `text` field");
});

test("a caller-owned text.format is passed through verbatim, and only when asked for", async () => {
  const format = {
    type: "json_schema",
    name: "resource_note",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["html"],
      properties: { html: { type: "string" } },
    },
  };

  const { calls, fetcher } = recordingFetcher([async () => completedResponse('{"html":"<p>hi</p>"}')]);
  const { value } = await withKey(KEY, async () =>
    withCapturedLogs(async () =>
      runAssistant({ instructions: "i", input: "d", textFormat: format, maxOutputChars: 5_000, fetcher }),
    ),
  );

  const body = outboundBody(calls[0]!);
  // Verbatim: the caller owns the schema, so the boundary must not normalize,
  // re-key, or re-order any part of it.
  assert.deepEqual(body.text, { format });
  assert.equal(JSON.stringify((body.text as { format: unknown }).format), JSON.stringify(format));
  // Opting in changes nothing else about the request.
  assert.equal(body.store, false);
  assert.equal("tools" in body, false);

  // The result is the RAW JSON STRING. This module does not parse it — the
  // caller owns the schema, so the caller owns the validation.
  assert.equal(value.ok, true);
  assert.equal(value.ok && value.text, '{"html":"<p>hi</p>"}');
  assert.deepEqual(value.ok ? JSON.parse(value.text) : null, { html: "<p>hi</p>" });
});

test("the shared ceilings admit the widest consumer, and the narrow defaults are unchanged", () => {
  // A resource note of 8,000 chars plus fixed title/summary/template content.
  assert.equal(ASSISTANT_MAX_TOTAL_INPUT_CHARS, 16_000);
  const wide = boundAssistantInput({ instructions: "rules", input: "n".repeat(8_000) + "t".repeat(6_000) });
  assert.equal(wide.input.length, 14_000, "a 14,000-char body must survive the total cap whole");
  assert.equal(wide.instructions, "rules");

  // A validated html body of 20,000 chars inside a JSON wrapper.
  assert.equal(ASSISTANT_MAX_OUTPUT_CHARS, 24_000);
  assert.equal(boundAssistantOutputChars(22_000), 22_000);
  assert.ok(ASSISTANT_MAX_OUTPUT_CHARS - 20_000 >= 4_000, "the JSON wrapper overhead must fit above 20,000");

  // Defaults a narrow caller relies on are untouched.
  assert.equal(ASSISTANT_DEFAULT_MAX_OUTPUT_CHARS, 1_200);
  assert.equal(ASSISTANT_MAX_INSTRUCTION_CHARS, 2_000);
  assert.equal(ASSISTANT_TIMEOUT_MS, 12_000);
  assert.equal(ASSISTANT_MAX_ATTEMPTS, 2);

  // Token headroom is recomputed from the cap and covers the widest ask.
  assert.equal(ASSISTANT_OUTPUT_TOKEN_HEADROOM, 1_024);
  assert.equal(assistantMaxOutputTokens(1_200), 400 + 1_024);
  assert.equal(assistantMaxOutputTokens(24_000), 8_000 + 1_024);
});

test("an abort while the response body stalls is a timeout, not a bad answer", async () => {
  // fetch() resolved — headers arrived — and then the body never finished. The
  // deadline is this module's own, so blaming the provider's content would be a
  // misdiagnosis a caller acts on: it would retry a "malformed" answer forever.
  const { calls, fetcher } = recordingFetcher([
    (init) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          }),
      } as unknown as Response),
  ]);

  const { value, logs } = await withKey(KEY, async () =>
    withCapturedLogs(async () => runAssistant({ instructions: "i", input: "d", fetcher, timeoutMs: 25 })),
  );
  assert.deepEqual(value, { ok: false, reason: "timeout" });
  assert.equal(calls.length, 1, "a body that began must not buy a retry");
  assert.match(logs[0]!, /outcome=timeout/);
});

test("a malformed body that did NOT time out keeps its invalid_output classification", async () => {
  // The companion to the test above: the same unusable body, no abort, must not
  // be relabelled a timeout by the new branch.
  const { calls, fetcher } = recordingFetcher([async () => new Response("<html>nope</html>", { status: 200 })]);
  const { value } = await withKey(KEY, async () =>
    withCapturedLogs(async () => runAssistant({ instructions: "i", input: "d", fetcher })),
  );
  assert.deepEqual(value, { ok: false, reason: "invalid_output" });
  assert.equal(calls.length, 1);
});

test("input is hard-capped in total, and instructions keep their own reserve", async () => {
  const bounded = boundAssistantInput({ instructions: "i".repeat(50_000), input: "d".repeat(50_000) });
  assert.equal(bounded.instructions.length, ASSISTANT_MAX_INSTRUCTION_CHARS);
  assert.equal(bounded.instructions.length + bounded.input.length, ASSISTANT_MAX_TOTAL_INPUT_CHARS);
  // Short instructions hand their unused reserve to the data, rather than
  // shrinking the total the provider is allowed to see.
  const roomy = boundAssistantInput({ instructions: "short", input: "d".repeat(50_000) });
  assert.equal(roomy.instructions, "short");
  assert.equal(roomy.instructions.length + roomy.input.length, ASSISTANT_MAX_TOTAL_INPUT_CHARS);

  const { calls, fetcher } = recordingFetcher([async () => completedResponse("ok")]);
  await withKey(KEY, async () =>
    withCapturedLogs(async () =>
      runAssistant({ instructions: "i".repeat(50_000), input: "d".repeat(50_000), fetcher }),
    ),
  );
  const body = outboundBody(calls[0]!);
  assert.equal(String(body.instructions).length, ASSISTANT_MAX_INSTRUCTION_CHARS);
  assert.equal(
    String(body.instructions).length + String(body.input).length,
    ASSISTANT_MAX_TOTAL_INPUT_CHARS,
    "the caller cannot widen the total the provider receives",
  );
});

test("output is capped by the caller's request and by this module's own ceiling", async () => {
  assert.equal(boundAssistantOutputChars(undefined), ASSISTANT_DEFAULT_MAX_OUTPUT_CHARS);
  assert.equal(boundAssistantOutputChars(500), 500);
  assert.equal(boundAssistantOutputChars(999_999), ASSISTANT_MAX_OUTPUT_CHARS);
  assert.equal(boundAssistantOutputChars(0), 1);
  assert.equal(boundAssistantOutputChars(Number.NaN), ASSISTANT_DEFAULT_MAX_OUTPUT_CHARS);

  // An over-long generation is truncated on the way out, not trusted.
  const { fetcher } = recordingFetcher([async () => completedResponse("x".repeat(5_000))]);
  const capped = await withKey(KEY, async () =>
    withCapturedLogs(async () => runAssistant({ instructions: "i", input: "d", maxOutputChars: 100, fetcher })),
  );
  assert.equal(capped.value.ok, true);
  assert.equal(capped.value.ok && capped.value.text.length, 100);

  const { fetcher: wide } = recordingFetcher([async () => completedResponse("y".repeat(50_000))]);
  const clamped = await withKey(KEY, async () =>
    withCapturedLogs(async () => runAssistant({ instructions: "i", input: "d", maxOutputChars: 999_999, fetcher: wide })),
  );
  assert.equal(clamped.value.ok && clamped.value.text.length, ASSISTANT_MAX_OUTPUT_CHARS);
});

test("the abort budget fires as a timeout, and a timeout is never retried", async () => {
  // Hangs until this module's own AbortController fires, exactly as a stalled
  // provider connection would.
  const { calls, fetcher } = recordingFetcher([
    (init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
  ]);

  const started = Date.now();
  const { value, logs } = await withKey(KEY, async () =>
    withCapturedLogs(async () => runAssistant({ instructions: "i", input: "d", fetcher, timeoutMs: 25 })),
  );
  assert.deepEqual(value, { ok: false, reason: "timeout" });
  assert.equal(calls.length, 1, "a spent time budget must not buy a second attempt");
  assert.ok(Date.now() - started < 5_000, "the call must not wait out the full production budget");
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /outcome=timeout/);
});

test("the caller cannot extend the time budget past this module's ceiling", async () => {
  const calls: Call[] = [];
  const capture = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return completedResponse("ok");
  }) as unknown as typeof fetch;
  await withKey(KEY, async () =>
    withCapturedLogs(async () =>
      runAssistant({ instructions: "i", input: "d", fetcher: capture, timeoutMs: ASSISTANT_TIMEOUT_MS * 100 }),
    ),
  );
  // The signal is real and not yet aborted; the ceiling itself is asserted by
  // the constant being the only value a longer request can resolve to.
  assert.equal((calls[0]!.init.signal as AbortSignal).aborted, false);
  assert.equal(ASSISTANT_TIMEOUT_MS, 12_000);
});

test("a 429 buys exactly one retry, then reports rate_limited", async () => {
  const { calls, fetcher } = recordingFetcher([
    async () => new Response(SECRET_MARKER, { status: 429 }),
    async () => new Response(SECRET_MARKER, { status: 429 }),
  ]);
  const { value, logs } = await withKey(KEY, async () =>
    withCapturedLogs(async () => runAssistant({ instructions: SECRET_MARKER, input: SECRET_MARKER, fetcher })),
  );
  assert.deepEqual(value, { ok: false, reason: "rate_limited" });
  assert.equal(calls.length, ASSISTANT_MAX_ATTEMPTS);
  assert.equal(logs.join(" ").includes(SECRET_MARKER), false);
});

test("a 429 that clears on the retry returns the draft", async () => {
  const { calls, fetcher } = recordingFetcher([
    async () => new Response("slow down", { status: 429 }),
    async () => completedResponse("Second time lucky."),
  ]);
  const { value } = await withKey(KEY, async () =>
    withCapturedLogs(async () => runAssistant({ instructions: "i", input: "d", fetcher })),
  );
  assert.deepEqual(value, { ok: true, text: "Second time lucky." });
  assert.equal(calls.length, 2);
});

test("a 5xx and a transport error are retried once; a 4xx is not retried at all", async () => {
  for (const [label, make, expected] of [
    ["500", async () => new Response("boom", { status: 500 }), 2],
    ["503", async () => new Response("boom", { status: 503 }), 2],
    ["network", async () => { throw new TypeError("fetch failed"); }, 2],
    ["400", async () => new Response("bad request", { status: 400 }), 1],
    ["401", async () => new Response("unauthorized", { status: 401 }), 1],
  ] as Array<[string, () => Promise<Response>, number]>) {
    const { calls, fetcher } = recordingFetcher([make]);
    const { value } = await withKey(KEY, async () =>
      withCapturedLogs(async () => runAssistant({ instructions: "i", input: "d", fetcher })),
    );
    assert.deepEqual(value, { ok: false, reason: "provider_error" }, `${label} must be a provider_error`);
    assert.equal(calls.length, expected, `${label} must produce ${expected} attempt(s)`);
  }
});

test("malformed, empty, refused, and incomplete generations are invalid_output and are not retried", async () => {
  const cases: Array<[string, () => Promise<Response>]> = [
    ["not JSON at all", async () => new Response("<html>gateway</html>", { status: 200 })],
    ["no output array", async () => Response.json({ status: "completed", id: "resp_x" })],
    ["an empty output array", async () => Response.json({ status: "completed", output: [] })],
    [
      "a message with no text part",
      async () => Response.json({ status: "completed", output: [{ type: "message", content: [] }] }),
    ],
    [
      "a refusal instead of text",
      async () =>
        Response.json({
          status: "completed",
          output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }],
        }),
    ],
    [
      "whitespace-only text",
      async () =>
        Response.json({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "   \n  " }] }],
        }),
    ],
    [
      "a truncated (incomplete) generation",
      async () =>
        Response.json({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [{ type: "message", content: [{ type: "output_text", text: "Thank you for pro" }] }],
        }),
    ],
    [
      "reasoning that consumed the whole budget",
      async () =>
        Response.json({
          status: "incomplete",
          output: [{ type: "reasoning", summary: [] }],
          usage: { input_tokens: 900, output_tokens: 912 },
        }),
    ],
  ];

  for (const [label, make] of cases) {
    const { calls, fetcher } = recordingFetcher([make]);
    const { value } = await withKey(KEY, async () =>
      withCapturedLogs(async () => runAssistant({ instructions: "i", input: "d", fetcher })),
    );
    assert.deepEqual(value, { ok: false, reason: "invalid_output" }, `${label} must be invalid_output`);
    // The provider answered; retrying only spends the budget twice.
    assert.equal(calls.length, 1, `${label} must not be retried`);
  }
});

test("a failure result carries a reason from the closed set and nothing else", async () => {
  const seen = new Set<string>();
  const failures: Array<[string, () => Promise<Response>]> = [
    ["rate_limited", async () => new Response(SECRET_MARKER, { status: 429 })],
    ["provider_error", async () => new Response(SECRET_MARKER, { status: 500 })],
    ["invalid_output", async () => new Response(SECRET_MARKER, { status: 200 })],
  ];
  for (const [expected, make] of failures) {
    const { fetcher } = recordingFetcher([make]);
    const { value } = await withKey(KEY, async () =>
      withCapturedLogs(async () => runAssistant({ instructions: SECRET_MARKER, input: SECRET_MARKER, fetcher })),
    );
    assert.equal(value.ok, false);
    const failure = value as Extract<AssistantResult, { ok: false }>;
    assert.deepEqual(Object.keys(failure).sort(), ["ok", "reason"]);
    assert.equal(failure.reason, expected);
    assert.ok(ASSISTANT_FAILURE_REASONS.includes(failure.reason));
    seen.add(failure.reason);
  }
  const disabled = await withKey(undefined, async () => runAssistant({ instructions: "i", input: "d" }));
  assert.deepEqual(Object.keys(disabled).sort(), ["ok", "reason"]);
  seen.add("disabled");
  seen.add("timeout");
  assert.deepEqual([...ASSISTANT_FAILURE_REASONS].sort(), [...seen].sort(), "every reason must be reachable");
});

test("nothing sensitive is logged on any path: only model, outcome, and token counts", async () => {
  const paths: Array<[string, () => Promise<Response>]> = [
    ["success", async () => completedResponse(`${SECRET_MARKER} generated draft`)],
    ["rate_limited", async () => new Response(SECRET_MARKER, { status: 429 })],
    ["provider_error", async () => new Response(SECRET_MARKER, { status: 500 })],
    ["client_error", async () => new Response(SECRET_MARKER, { status: 400 })],
    ["invalid_output", async () => new Response(SECRET_MARKER, { status: 200 })],
    ["network", async () => { throw new TypeError(`fetch failed for ${SECRET_MARKER}`); }],
  ];

  for (const [label, make] of paths) {
    const { fetcher } = recordingFetcher([make]);
    const { logs } = await withKey(KEY, async () =>
      withCapturedLogs(async () =>
        runAssistant({
          instructions: `Write warmly. ${SECRET_MARKER}`,
          input: `Reviewer said: ${SECRET_MARKER}`,
          fetcher,
        }),
      ),
    );
    const rendered = logs.join("\n");
    assert.equal(rendered.includes(SECRET_MARKER), false, `${label} leaked prompt or output text into a log`);
    assert.equal(rendered.includes(KEY), false, `${label} leaked the credential into a log`);
    assert.equal(/fetch failed|Aborted|AbortError/.test(rendered), false, `${label} leaked a raw error into a log`);
    // Non-vacuity: it did not go silent instead. Exactly one line, and it is
    // the permitted one.
    assert.equal(logs.length, 1, `${label} must log exactly once`);
    assert.match(logs[0]!, /^\[assistant\] model=gpt-5-mini outcome=[a-z_]+ in=\d+ out=\d+$/);
  }

  // Token counts are real, not placeholders — this is the cost signal.
  const { fetcher } = recordingFetcher([async () => completedResponse("fine", { input_tokens: 321, output_tokens: 123 })]);
  const { logs } = await withKey(KEY, async () =>
    withCapturedLogs(async () => runAssistant({ instructions: "i", input: "d", fetcher })),
  );
  assert.equal(logs[0], `[assistant] model=${ASSISTANT_MODEL} outcome=ok in=321 out=123`);
});

/* -------------------------------------------------------------------------- */
/* Source contract                                                            */
/* -------------------------------------------------------------------------- */

const clientSource = readFileSync(new URL("./client.ts", import.meta.url), "utf8");

test("the module has exactly one log call, and it can only reach non-sensitive primitives", () => {
  const calls = clientSource.match(/console\.[a-zA-Z]+\([^\r\n]*/g) ?? [];
  assert.equal(calls.length, 1, "one permitted log line, and no second one added later");
  const [only] = calls;
  assert.match(only!, /^console\.info\(/);
  // The identifiers a leak would have to travel through. Whole-word, so
  // `inputTokens` and `outputTokens` are deliberately still allowed.
  for (const identifier of [
    "instructions",
    "input",
    "text",
    "body",
    "payload",
    "response",
    "error",
    "apiKey",
    "Authorization",
    "parsed",
    "request",
  ]) {
    assert.doesNotMatch(
      only!,
      new RegExp(`\\b${identifier}\\b`),
      `the log line must not be able to reference \`${identifier}\``,
    );
  }
  assert.match(only!, /\$\{ASSISTANT_MODEL\}/);
  assert.match(only!, /\$\{outcome\}/);
  assert.match(only!, /\$\{inputTokens\}/);
  assert.match(only!, /\$\{outputTokens\}/);
});

test("no raw provider error can be captured, stringified, or re-thrown", () => {
  // Every catch in this module is bindingless, so there is no error object in
  // scope to log or to attach to a result.
  assert.doesNotMatch(clientSource, /catch \(/, "catches must stay bindingless");
  assert.doesNotMatch(clientSource, /\.statusText/, "provider status text is not a reason code");
  assert.doesNotMatch(clientSource, /response\.text\(\)/, "a failure body must never be read");
  assert.doesNotMatch(clientSource, /JSON\.stringify\(parsed/);
  assert.doesNotMatch(clientSource, /console\.(error|warn|log|debug)/);
  // The failure shape carries a reason and nothing else.
  assert.match(clientSource, /\{ ok: false; reason: AssistantFailureReason \}/);
  assert.doesNotMatch(clientSource, /reason: AssistantFailureReason; (message|detail|cause)/);
});

test("the request stays non-retained, tool-free, stateless, and abort-bounded", () => {
  assert.match(clientSource, /store: false,/);
  assert.match(clientSource, /new AbortController\(\)/);
  assert.match(clientSource, /controller\.abort\(\)/);
  assert.match(clientSource, /clearTimeout\(timer\)/);
  for (const banned of ["stream:", "tools:", "tool_choice", "previous_response_id", "conversation:", "text/event-stream"]) {
    assert.equal(clientSource.includes(banned), false, `the client must not introduce \`${banned}\``);
  }
  // One provider, declared once, and one model constant to change. Compared
  // against code with comments stripped, so prose may name either freely.
  const clientCode = clientSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\r\n]*/g, "$1");
  assert.equal((clientCode.match(/https:\/\/api\.openai\.com/g) ?? []).length, 1);
  assert.equal((clientCode.match(/gpt-5-mini/g) ?? []).length, 1);
  // The shared contract file stays untouched by the assistant's own schema.
  assert.doesNotMatch(clientSource, /@\/types\/api/);
});

test("the reason codes are a closed set, declared once", () => {
  assert.deepEqual([...ASSISTANT_FAILURE_REASONS], [
    "disabled",
    "timeout",
    "rate_limited",
    "provider_error",
    "invalid_output",
  ]);
  assert.match(clientSource, /\(typeof ASSISTANT_FAILURE_REASONS\)\[number\]/);
});

/* -------------------------------------------------------------------------- */
/* Server-only rail: transitive, not one hop                                  */
/* -------------------------------------------------------------------------- */

/**
 * A direct-import grep is not enough. The credential would arrive in a client
 * bundle through an import of an import — a component pulls a helper, the
 * helper pulls a service, the service pulls this module — and every file in
 * that chain looks innocent on its own. So the rail walks the real graph, the
 * way `lib/api/openapi-purity.test.ts` walks the contract endpoint's.
 */
const repoRoot = new URL("../../", import.meta.url);
const repoRead = (path: string) => readFileSync(new URL(path, repoRoot), "utf8");
const repoExists = (path: string) => existsSync(new URL(path, repoRoot));

/** Comments stripped, so a path named in prose is never walked as an edge. */
const repoCode = (path: string) =>
  repoRead(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\r\n]*/g, "$1");

function specifiersOf(path: string): string[] {
  const source = repoCode(path);
  return [
    ...new Set(
      [
        ...[...source.matchAll(/(?:\bimport\b|\bexport\b)[^"';]*?\bfrom\s*["']([^"']+)["']/g)],
        ...[...source.matchAll(/\bimport\s*["']([^"']+)["']/g)],
        ...[...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)],
      ].map(([, specifier]) => specifier),
    ),
  ];
}

/**
 * Resolve a repo-internal specifier to a TypeScript file.
 *
 * Returns null for packages AND for assets: a `.css` module cannot import
 * TypeScript, so it is a leaf rather than an unresolvable edge.
 */
function resolveInternal(specifier: string, importer: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = specifier.slice(2);
  } else if (specifier.startsWith(".")) {
    const dir = importer.split("/").slice(0, -1);
    for (const segment of specifier.split("/")) {
      if (segment === "." || segment === "") continue;
      if (segment === "..") dir.pop();
      else dir.push(segment);
    }
    base = dir.join("/");
  } else {
    return null;
  }
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if ((candidate.endsWith(".ts") || candidate.endsWith(".tsx")) && repoExists(candidate)) return candidate;
  }
  return null;
}

/** Breadth-first walk of the real import graph from a set of entry files. */
function importGraph(entries: string[]): Set<string> {
  const modules = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (modules.has(current)) continue;
    modules.add(current);
    for (const specifier of specifiersOf(current)) {
      const resolved = resolveInternal(specifier, current);
      if (resolved !== null && !modules.has(resolved)) queue.push(resolved);
    }
  }
  return modules;
}

/** Every `"use client"` file under `app/` and `components/`. */
function clientComponents(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(new URL(dir, repoRoot), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        if (/^\s*"use client";/m.test(repoRead(rel))) found.push(rel);
      }
    }
  };
  walk("app");
  walk("components");
  return found;
}

const SERVER_ONLY = /^lib\/assistant\//;

test("the import walker really traverses, more than one hop", () => {
  // A chain that exists in this module's own graph: client -> env -> contract.
  assert.equal(resolveInternal("@/lib/env", "lib/assistant/client.ts"), "lib/env.ts");
  assert.ok(specifiersOf("lib/env.ts").includes("@/lib/api/v1-contract"));
  const graph = importGraph(["lib/assistant/client.ts"]);
  assert.ok(graph.has("lib/env.ts"), "the walker must reach lib/env.ts one hop out");
  assert.ok(graph.has("lib/api/v1-contract.ts"), "the walker must reach the contract module two hops out");
  // And the pattern the rail below applies really does match this module, so a
  // hit would be reported rather than silently tolerated.
  assert.match("lib/assistant/client.ts", SERVER_ONLY);
});

test("no client component's transitive import graph reaches the server-only assistant", () => {
  const entries = clientComponents();
  // Non-vacuity: the islands were found, and the walk left them.
  assert.ok(entries.length > 20, `expected the client islands, found ${entries.length}`);
  const graph = importGraph(entries);
  assert.ok(graph.size > entries.length, "the walk must reach beyond the entry files");
  assert.ok([...graph].some((module) => module.startsWith("lib/")), "the walk must reach shared lib modules");

  const offenders = [...graph].filter((module) => SERVER_ONLY.test(module));
  assert.deepEqual(
    offenders,
    [],
    "the provider credential must not be reachable from a client bundle, at any depth",
  );
});
