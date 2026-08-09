import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../components/cfp-form.tsx", import.meta.url), "utf8");

test("CFP recovery keeps capabilities out of query strings and strips fragments before body-only calls", () => {
  assert.match(source, /window\.history\.replaceState\(/);
  assert.match(source, /withoutDraftRecoveryHash\(window\.location\.pathname, window\.location\.search\)/);
  assert.match(source, /apiPost<ResumeDraftResult>\("\/api\/cfp\/submissions\/resume", \{/);
  assert.match(source, /draftCapability: candidate\.capability/);
  assert.match(source, /expectedDraftRevision: currentDraft\.draftRevision/);
  assert.match(source, /if \(!stripDraftRecoveryFragment\(\)\.safeToRequest\) \{/);
  assert.match(source, /hasDraftRecoveryHash\(window\.location\.hash\)/);
  assert.match(source, /const parsedFragment = parseDraftRecoveryHash\(window\.location\.hash\);[\s\S]*?const stored = readDraftRecovery\(browserStorage\(\), form\.id\);/);
  assert.doesNotMatch(source, /submissions\/resume\?[^\n]*/);
});

test("CFP recovery guards browser storage and does not store form values", () => {
  const recovery = readFileSync(new URL("./cfp-draft-recovery.ts", import.meta.url), "utf8");
  assert.match(recovery, /try \{[\s\S]*storage\.getItem/);
  assert.match(recovery, /try \{[\s\S]*storage\.setItem/);
  assert.match(recovery, /try \{[\s\S]*storage\.removeItem/);
  assert.doesNotMatch(recovery, /speakers|answersByKey|abstract:\s*/);
});

test("a delayed resume cannot activate a draft after newer typing, and cross-tab revocation clears only metadata", () => {
  const staleResponseBranch = source.match(/if \(!shouldApplyRecoveredDraft\(editVersionAtRequest, editVersionRef\.current\)\) \{([\s\S]*?)return;\s*\}/)?.[1];
  assert.ok(staleResponseBranch?.includes("setRecoveryCandidate(recovered);"));
  assert.ok(staleResponseBranch?.includes("setRecoveryNotice(\"conflict\");"));
  assert.equal(staleResponseBranch?.includes("persistDraftRecovery"), false);
  assert.match(source, /if \(!next && current\) \{[\s\S]*?discardDraftRecovery\(\);[\s\S]*?setRecoveryNotice\("unavailable"\);/);
  assert.match(source, /setBusy\(\(current\) => current === "resume" \? null : current\);/);
  assert.match(source, /busy === "resume" \? <p className="hint" role="status" aria-live="polite">Restoring saved draft…<\/p> : null/);
});
