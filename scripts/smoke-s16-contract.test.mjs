import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const smoke = readFileSync(new URL("./_smoke.mjs", import.meta.url), "utf8");
const PRISMA_INTERACTIVE_TRANSACTION_DEFAULT_MS = 5_000;

test("S16 compatible-public observation leaves headroom for the default route transaction", () => {
  const match = smoke.match(/observeBeforeDeadline\(compatiblePublicSubmit, (\d[\d_]*)\)/);
  assert.ok(match, "S16 compatible-public observation is present");
  const deadline = Number(match[1].replaceAll("_", ""));
  assert.ok(deadline < PRISMA_INTERACTIVE_TRANSACTION_DEFAULT_MS);
  assert.match(smoke, /const compatiblePublicAbort = new AbortController\(\)/);
  assert.match(smoke, /if \(!compatiblePublicObservation\?\.completed\) compatiblePublicAbort\.abort\(\)/);
  assert.match(smoke, /s16AbstractHolder[\s\S]{0,700}\{ timeout: 15_000 \}/);
});
