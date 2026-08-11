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
