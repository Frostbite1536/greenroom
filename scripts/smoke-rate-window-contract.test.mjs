import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const smoke = readFileSync(new URL("./_smoke.mjs", import.meta.url), "utf8");

test("rate-boundary smoke proofs use real HTTP writers without mirrored windows", () => {
  assert.match(smoke, /for \(let index = 1; index <= 11; index\+\+\)/);
  assert.match(smoke, /s19EmailCapAttempts\.slice\(0, 10\)\.every/);
  assert.doesNotMatch(smoke, /s19EmailWindowStarts|s19EmailWindowStart/);
  assert.match(smoke, /DELETE FROM "PublicSubmissionRateBucket" WHERE "eventId" = \$\{SCRATCH_EVENT\.id\}/);

  assert.match(smoke, /for \(let index = 0; index < 40; index\+\+\)/);
  assert.match(smoke, /const email = `c17-cap-\$\{index\}@scratch\.test`/);
  assert.match(smoke, /sendWindowStart: \{\s*gte: observerWindowStart,\s*lt: new Date/);
  assert.match(smoke, /c17CapWindowCount = countRows\._sum\.sendWindowCount \?\? 0/);
  assert.match(smoke, /if \(c17CapWindowCount === 20\) break/);
  assert.match(smoke, /c17CapWindowCount === 20/);
  assert.match(smoke, /event-hour cap primer identities are removed after the assertion/);
  assert.doesNotMatch(smoke, /c17CapWindowStart/);
  assert.match(smoke, /scratch-owned reviewer invite rows are cleared at final teardown/);
});
