import { createServer } from "node:http";

const rawPort = process.argv[2] ?? "3413";
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("Assistant mock port must be an integer from 1 through 65535.");
}

const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1_024;
const FAILURE_MARKER = "[mock:provider-error]";
const MALFORMED_MARKER = "[mock:malformed-output]";
const DECISION_SCHEMA = "greenroom_decision_note";
const OWNED_AUTHORIZATION = "Bearer greenroom-e2e-owned-provider-key-not-a-secret";
const DECISION_DRAFT =
  "Your session stood out for how concretely it treats the day-to-day of running a large event, and the program team is glad to have it.";
const DECISION_SLOW_MS = 2_000;
const decisionState = { modes: [], requests: [] };

function json(response, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(bytes.length),
    "Cache-Control": "no-store",
  });
  response.end(bytes);
}

async function readJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && expected.every((key, index) => keys[index] === key);
}

function resourceInput(body) {
  if (body?.store !== false || "tools" in body || "tool_choice" in body || "previous_response_id" in body) return null;
  if (body?.text?.format?.name !== "greenroom_resource_draft" || body.text.format.strict !== true) return null;
  if (typeof body.instructions !== "string" || !body.instructions.includes("untrusted reference data")) return null;
  if (typeof body.input !== "string") return null;

  let input;
  try {
    input = JSON.parse(body.input);
  } catch {
    return null;
  }
  const allowedTop = input.summary === undefined
    ? ["notes", "template", "title"]
    : ["notes", "summary", "template", "title"];
  if (!exactKeys(input, allowedTop)) return null;
  if (!exactKeys(input.template, ["key", "label", "sections"])) return null;
  if (!Array.isArray(input.template.sections)) return null;
  if (!input.template.sections.every((section) => exactKeys(section, ["heading", "key"]))) return null;
  if (typeof input.title !== "string" || typeof input.notes !== "string") return null;
  if (input.summary !== undefined && typeof input.summary !== "string") return null;
  return input;
}

function decisionInput(body) {
  if (body?.store !== false || "tools" in body || "tool_choice" in body || "previous_response_id" in body) return null;
  if (body?.text?.format?.name !== DECISION_SCHEMA || body.text.format.strict !== true) return null;
  if (typeof body.instructions !== "string" || typeof body.input !== "string") return null;
  return body.input;
}

function responsePayload(outputText) {
  return {
    id: "resp_greenroom_e2e",
    object: "response",
    status: "completed",
    output: [
      { id: "reasoning_greenroom_e2e", type: "reasoning", summary: [] },
      {
        id: "message_greenroom_e2e",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: outputText, annotations: [] }],
      },
    ],
    usage: { input_tokens: 100, output_tokens: 100 },
  };
}

function validDecisionControl(value) {
  if (!exactKeys(value, ["modes"]) || !Array.isArray(value.modes) || value.modes.length > 5) return false;
  return value.modes.every((mode) => ["success", "slow", "server-error"].includes(mode));
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    json(response, 200, { ok: true });
    return;
  }
  if (request.url === "/_control/decision" && request.method === "POST") {
    const control = await readJson(request);
    if (!validDecisionControl(control)) {
      json(response, 400, { error: "invalid_control" });
      return;
    }
    decisionState.modes = [...control.modes];
    decisionState.requests = [];
    json(response, 200, { ok: true });
    return;
  }
  if (request.url === "/_control/decision" && request.method === "GET") {
    json(response, 200, { ok: true, requests: decisionState.requests });
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    json(response, 404, { error: "not_found" });
    return;
  }
  if (!request.headers.authorization?.startsWith("Bearer ")) {
    json(response, 401, { error: "unauthorized" });
    return;
  }

  const body = await readJson(request);
  const decision = decisionInput(body);
  if (decision !== null) {
    decisionState.requests.push({
      body,
      authorizationOwned: request.headers.authorization === OWNED_AUTHORIZATION,
    });
    if (decisionState.requests.length > 10) decisionState.requests.shift();
    const mode = decisionState.modes.shift() ?? "success";
    if (mode === "server-error") {
      json(response, 500, { error: "mock_provider_unavailable" });
      return;
    }
    if (mode === "slow") {
      await new Promise((resolve) => setTimeout(resolve, DECISION_SLOW_MS));
    }
    json(response, 200, responsePayload(JSON.stringify({ draft: DECISION_DRAFT })));
    return;
  }

  const input = resourceInput(body);
  if (!input) {
    json(response, 400, { error: "contract_refused" });
    return;
  }
  if (input.notes.includes(FAILURE_MARKER)) {
    json(response, 503, { error: "mock_provider_unavailable" });
    return;
  }

  const outputText = input.notes.includes(MALFORMED_MARKER)
    ? "not-json"
    : JSON.stringify({
        html: [
          "<h2>Welcome, speakers</h2>",
          "<p>Slides are due Friday.</p>",
          "<p onclick=\"globalThis.__ASSISTANT_PREVIEW_EXECUTED=true\">Check in with the speaker team.</p>",
          "<script>globalThis.__ASSISTANT_PREVIEW_EXECUTED=true</script>",
          "<style>body{display:none}</style>",
          "<iframe src=\"https://example.invalid\"></iframe>",
          "<svg><script>globalThis.__ASSISTANT_PREVIEW_EXECUTED=true</script></svg>",
          "<a href=\"javascript:alert(1)\">Unsafe link</a>",
          "<h3>Key dates</h3><p>[Add speaker check-in time]</p>",
          "<h3>Before you arrive</h3><p>[Add arrival guidance]</p>",
          "<h3>Presentation guidance</h3><p>[Add presentation guidance]</p>",
          "<h3>Need help?</h3><p>[Add the event-approved contact method]</p>",
        ].join(""),
        grounding: {
          templateKey: "speaker-handbook",
          sectionsUsed: ["welcome", "key-dates", "before-arrival", "presentation", "help"],
          placeholders: [
            "[Add speaker check-in time]",
            "[Add arrival guidance]",
            "[Add presentation guidance]",
            "[Add the event-approved contact method]",
          ],
        },
      });

  json(response, 200, responsePayload(outputText));
});

server.listen(port, HOST, () => {
  console.info(`[assistant-mock] ready on loopback port ${port}`);
});

function stop() {
  server.close(() => process.exit(0));
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
