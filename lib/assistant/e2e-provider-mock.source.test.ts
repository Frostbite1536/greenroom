import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../e2e/assistant-provider-mock.mjs", import.meta.url), "utf8");

test("the browser provider mock is loopback-only, bounded, and lifecycle-owned", () => {
  assert.match(source, /const HOST = "127\.0\.0\.1"/);
  assert.match(source, /const MAX_BODY_BYTES = 64 \* 1_024/);
  assert.match(source, /if \(total > MAX_BODY_BYTES\) return null/);
  assert.match(source, /server\.listen\(port, HOST/);
  assert.match(source, /process\.on\("SIGTERM", stop\)/);
  assert.match(source, /process\.on\("SIGINT", stop\)/);
  assert.doesNotMatch(source, /0\.0\.0\.0|::/);
});

test("the mock refuses retention, tools, unknown input fields, and a missing strict schema", () => {
  assert.match(source, /body\?\.store !== false/);
  for (const forbidden of ["tools", "tool_choice", "previous_response_id"]) {
    assert.match(source, new RegExp(`\"${forbidden}\" in body`));
  }
  assert.match(source, /body\?\.text\?\.format\?\.name !== "greenroom_resource_draft"/);
  assert.match(source, /body\.text\.format\.strict !== true/);
  assert.match(source, /exactKeys\(input, allowedTop\)/);
  assert.deepEqual(
    [...source.matchAll(/\["notes", (?:"summary", )?"template", "title"\]/g)].map((match) => match[0]),
    ['["notes", "template", "title"]', '["notes", "summary", "template", "title"]'],
  );
});

test("one suite-owned provider dispatches both strict schemas with bounded decision controls", () => {
  assert.match(source, /"greenroom_resource_draft"/);
  assert.match(source, /const DECISION_SCHEMA = "greenroom_decision_note"/);
  assert.match(source, /request\.url === "\/_control\/decision" && request\.method === "POST"/);
  assert.match(source, /value\.modes\.length > 5/);
  assert.match(source, /\["success", "slow", "server-error"\]\.includes\(mode\)/);
  assert.match(source, /const mode = decisionState\.modes\.shift\(\) \?\? "success"/);
  assert.match(source, /authorizationOwned: request\.headers\.authorization === OWNED_AUTHORIZATION/);
  assert.match(source, /if \(decisionState\.requests\.length > 10\) decisionState\.requests\.shift\(\)/);
});

test("the mock logs no request, prompt, generated output, credential, or exception", () => {
  const logCalls = [...source.matchAll(/console\.(?:log|info|warn|error|debug)\(([^\r\n]*)\)/g)].map((match) => match[1]);
  assert.deepEqual(logCalls, ["`[assistant-mock] ready on loopback port ${port}`"]);
  assert.doesNotMatch(source, /console\.[^(]+\([^\r\n]*(?:body|input|notes|instructions|authorization|outputText|error)/);
  assert.doesNotMatch(source, /process\.env|OPENAI_API_KEY|DATABASE_URL/);
});
