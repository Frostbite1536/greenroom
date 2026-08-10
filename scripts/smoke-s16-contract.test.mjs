import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const smoke = readFileSync(new URL("./_smoke.mjs", import.meta.url), "utf8");
const PRISMA_INTERACTIVE_TRANSACTION_DEFAULT_MS = 5_000;

/**
 * The S16 compatibility probe runs the public writer to completion BEFORE the
 * speaker PATCH is issued, so the writer's hang guard no longer competes with
 * anyone's transaction budget. That inverts the old invariant: the hang guard
 * is deliberately generous, and the only window that must stay inside the
 * default route transaction budget is the speaker form-lock observation.
 */
test("S16 runs the public writer before the speaker PATCH, so its hang guard burns no budget", () => {
  const observation = smoke.match(/observeBeforeDeadline\(compatiblePublicSubmit, (\d[\d_]*)\)/);
  assert.ok(observation, "S16 compatible-public observation is present");
  const hangGuard = Number(observation[1].replaceAll("_", ""));

  // Ordering is the whole point of the reorder: the writer must be settled
  // before the speaker PATCH starts.
  const observedAt = smoke.indexOf("observeBeforeDeadline(compatiblePublicSubmit");
  const speakerPatchAt = smoke.indexOf('waitingSpeakerEdit = j("PATCH"');
  assert.ok(observedAt > 0 && speakerPatchAt > 0);
  assert.ok(observedAt < speakerPatchAt, "the public writer is observed before the speaker PATCH is issued");

  // A hang guard, not a race window — it must not be squeezed to fit a budget
  // that is no longer running during it.
  assert.ok(hangGuard >= PRISMA_INTERACTIVE_TRANSACTION_DEFAULT_MS);
  assert.match(smoke, /const compatiblePublicAbort = new AbortController\(\)/);
  assert.match(smoke, /if \(!compatiblePublicObservation\?\.completed\) compatiblePublicAbort\.abort\(\)/);

  // The held fixture transaction must outlast the hang guard plus the form
  // lock wait, or a fixture P2028 would mask the real failure.
  const holder = smoke.match(/s16AbstractHolder[\s\S]{0,900}?\{ timeout: (\d[\d_]*) \}/);
  assert.ok(holder, "the S16 abstract holder declares an explicit timeout");
  assert.ok(Number(holder[1].replaceAll("_", "")) > hangGuard);

  // The advisory lock is released through a finally, so an unexpected throw
  // cannot strand it behind that timeout.
  assert.match(smoke, /\} finally \{[\s\S]{0,300}?releaseS16AbstractLock\(\);\s*await s16AbstractHolder;/);
});

test("the S16 speaker form-lock wait stays inside the default route transaction budget", () => {
  const wait = smoke.match(
    /for \(let attempt = 0; attempt < (\d[\d_]*); attempt\+\+\) \{\s*const shares = await countSpeakerFormShareLocks\(\);[\s\S]*?setTimeout\(resolve, (\d[\d_]*)\)/,
  );
  assert.ok(wait, "the speaker form-lock wait loop is present");
  const attempts = Number(wait[1].replaceAll("_", ""));
  const intervalMs = Number(wait[2].replaceAll("_", ""));
  // This is the one window the waiting speaker PATCH pays for.
  assert.ok(attempts * intervalMs < PRISMA_INTERACTIVE_TRANSACTION_DEFAULT_MS);
});

test("the vacuous abstract-key waiter probe is gone", () => {
  // A fresh public CREATE passes no abstractId, so lockPublicDraftWrite never
  // takes `abstract-write:<id>` at all: watching for a second waiter on the
  // held key could never fire, and the observation proved nothing.
  assert.doesNotMatch(smoke, /pg_backend_pid/);
  assert.doesNotMatch(smoke, /s16PublicWaitedOnAbstract/);
  assert.doesNotMatch(smoke, /s16AbstractLockName/);
});
