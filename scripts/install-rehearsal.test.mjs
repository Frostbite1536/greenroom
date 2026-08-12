import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rehearsal = readFileSync(new URL("./install-rehearsal.mjs", import.meta.url), "utf8");

test("the clean-install rehearsal uses the canonical public CFP path with manual redirects", () => {
  assert.match(rehearsal, /req\("GET", "\/cfp\/forward-2026\/call-for-speakers", null, null\)/);
  assert.doesNotMatch(rehearsal, /req\("GET", "\/cfp\/call-for-speakers", null, null\)/);
});

test("the clean-install rehearsal proves acceptance provisions its Session without legacy conversion", () => {
  assert.match(rehearsal, /const sessionId = decide\.data\?\.data\?\.session\?\.id;/);
  assert.match(rehearsal, /sessionCreated === true && Boolean\(sessionId\)/);
  assert.doesNotMatch(rehearsal, /\/api\/evaluations\/convert/);
  assert.doesNotMatch(rehearsal, /convert to session → 201/);
});

test("the clean-install rehearsal submits typed checkbox and multiselect answers", () => {
  assert.match(
    rehearsal,
    /field\.type === "MULTISELECT"\) answers\[field\.key\] = \[field\.options\?\.\[0\]\?\.value \?\? ""\]/,
  );
  assert.match(rehearsal, /field\.type === "CHECKBOX"\) answers\[field\.key\] = true/);
  assert.doesNotMatch(rehearsal, /field\.type === "MULTISELECT" \|\| field\.type === "CHECKBOX"/);
});

test("the v1 guardrail asserts the credential contract a fresh install actually has", () => {
  // A fresh install configures no GREENROOM_API_KEY and issues no per-event
  // key, so an anonymous read is refused for want of a credential. Since scoped
  // credentials landed that refusal is 401, and NOT a claim that the surface is
  // unconfigured — a deployment can be fully configured with per-event keys
  // alone (the truth table lives in lib/api/v1.ts).
  assert.match(rehearsal, /req\("GET", "\/api\/v1\/schedule\?event=forward-2026", null, null\)/);
  assert.match(rehearsal, /v1\.status === 401 && v1\.data\?\.error\?\.code === "UNAUTHORIZED"/);
  // The guarantee this guardrail exists for is that no programme data comes
  // back, so it checks the payload rather than only the status line.
  assert.match(rehearsal, /v1\.data\?\.data === null/);
  // The superseded assertion must not come back.
  assert.doesNotMatch(rehearsal, /503/);
});
