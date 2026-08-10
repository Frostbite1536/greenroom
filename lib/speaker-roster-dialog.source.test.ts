import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Source contract for the roster dialogs. A stuck dialog is a rendering-time
 * property with no pure seam to observe, so the wiring itself is asserted —
 * the same style the repo already uses for component invariants.
 */
const source = readFileSync(new URL("../components/speaker-roster-manager.tsx", import.meta.url), "utf8");

test("neither dialog fires a submit whose rejection nobody handles", () => {
  // `void submit()` would discard the rejection, leaving the operator staring
  // at a disabled button with no error and no way to retry.
  assert.doesNotMatch(source, /void submit\(\)/);
  assert.equal((source.match(/submit\(\)\.catch\(/g) ?? []).length, 2);
});

test("a rejected submit clears the submitting state and says something actionable", () => {
  const recoveries = source.match(/submit\(\)\.catch\(\(error\) => \{[\s\S]*?\}\);/g) ?? [];
  assert.equal(recoveries.length, 2);
  for (const recovery of recoveries) {
    assert.match(recovery, /setSubmitting\(false\)/);
    assert.match(recovery, /setErrors\(\{ _root: speakerDialogRecovery\("(add|save)"\) \}\)/);
  }
  // The two call sites must not both claim the same action.
  assert.ok(recoveries.some((r) => r.includes('speakerDialogRecovery("add")')));
  assert.ok(recoveries.some((r) => r.includes('speakerDialogRecovery("save")')));
});

test("a root-level refusal reaches the operator as an alert, so a 409 is never silent", () => {
  // The shared-profile refusal carries its guidance in `error.message` with no
  // fieldErrors, so the `_root` fallback is the only thing that surfaces it.
  assert.match(source, /Object\.keys\(mapped\)\.length > 0 \? mapped : \{ _root: res\.error\.message \}/);
  assert.match(source, /rootError \? <p className="field-error" role="alert">\{rootError\}<\/p> : null/);
});

test("the add dialog reports which half of a shared-speaker add actually landed", () => {
  assert.match(source, /profileRequested: res\.data\.profileRequested/);
  assert.match(source, /profileApplied: res\.data\.profileApplied/);
});
