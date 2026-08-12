import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const smoke = readFileSync(new URL("./_smoke.mjs", import.meta.url), "utf8");

test("rate-boundary smoke fixtures cover one adjacent window without weakening cleanup", () => {
  assert.match(smoke, /const s19EmailWindowStarts = \[/);
  assert.match(smoke, /new Date\(s19EmailWindowStart\.getTime\(\) \+ s19EmailWindowMs\)/);
  assert.match(smoke, /data: s19EmailWindowStarts\.map\(\(windowStart\) => \(\{/);
  assert.match(smoke, /DELETE FROM "PublicSubmissionRateBucket" WHERE "eventId" = \$\{SCRATCH_EVENT\.id\}/);

  assert.match(smoke, /const c17CapWindowStart = new Date\(new Date\(\)\.setUTCMinutes\(0, 0, 0\)\)/);
  assert.match(smoke, /where: \{ id: c17RoleRaceStored\.id \}/);
  assert.match(smoke, /new Date\(c17CapWindowStart\.getTime\(\) \+ 60 \* 60 \* 1_000\)/);
  assert.match(smoke, /scratch-owned reviewer invite rows are cleared at final teardown/);
});
