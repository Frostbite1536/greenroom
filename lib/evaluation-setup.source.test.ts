/**
 * Source contract for the admin evaluation-setup screen.
 *
 * The properties pinned here are rendering and wiring facts, not pure
 * functions, so they cannot be reached through the comparator and weight tests
 * beside them. What they lock is the shape that makes the contract true: the
 * weight field never repairs its own input, the share line and the
 * different-ranges warning are actually mounted, and the rubric total is never
 * checked against 100.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const setup = () => source("components/evaluation-setup.tsx");

test("a weight draft is stored as typed, never coerced to a fallback number", () => {
  const component = setup();
  // The regression this replaces: `Number(e.target.value) || 1` silently turned
  // a cleared field and a typed 0 into a weight of 1.
  assert.equal(/weight:\s*Number\(/.test(component), false);
  // Scoped to the weight field: the round-ordinal input legitimately keeps its
  // own `|| 1` fallback, and a repo-wide ban would fail on that instead.
  assert.equal(/weight[^\n]*\|\|\s*1/.test(component), false);
  assert.match(component, /onChange=\{\(e\) => patch\(i, \{ weight: e\.target\.value \}\)\}/);
  // The draft type must stay a string, or the blank state becomes unrepresentable.
  assert.match(component, /weight:\s*string\s*\}/);
});

test("an unusable weight is reported on the field, not swallowed", () => {
  const component = setup();
  assert.match(component, /aria-invalid=\{rubricWeightError\(c\.weight\) !== null\}/);
  assert.match(component, /aria-describedby=\{`criterion-\$\{i\}-weight-note`\}/);
  assert.match(component, /id=\{`criterion-\$\{i\}-weight-note`\}/);
  // Not colour alone: the invalid class is paired with aria-invalid and with
  // replacement text in the same slot.
  assert.match(component, /criterion-weight-invalid/);
  // Saving refuses per criterion rather than repairing.
  assert.match(component, /rubricWeightError\(c\.weight\)/);
  assert.match(component, /setError\(`“\$\{badWeight\.criterion\.label\}”: \$\{badWeight\.message\}`\)/);
});

test("each criterion shows its share of the rubric weight, and the limit is shared with the API", () => {
  const component = setup();
  assert.match(component, /rubricWeightShareLine\(c\.weight, criteria\.map\(\(other\) => other\.weight\)\)/);
  // The client bound comes from the same module the Zod contract imports.
  assert.match(component, /max=\{RUBRIC_WEIGHT_MAX\}/);
  assert.match(component, /from "@\/lib\/rubric-weight"/);
  // Decimals must remain typeable.
  assert.match(component, /step="any"/);

  const contract = source("types/api.ts");
  assert.match(contract, /import \{ RUBRIC_WEIGHT_MAX \} from "@\/lib\/rubric-weight"/);
  assert.match(
    contract,
    /weight: z\.number\(\)\.finite\(\)\.positive\(\)\.max\(RUBRIC_WEIGHT_MAX\)\.default\(1\)/,
  );
});

test("the rubric total is never treated as a validity target", () => {
  const component = setup();
  // No sum-to-100 check, no "should total" copy, and no warning keyed on the
  // total. Weights are relative multipliers (D-C5-8 §2.2).
  assert.equal(/total(s)?\s*(===|!==|>|<|>=|<=)\s*100/.test(component), false);
  assert.equal(/add up to 100\b(?!,)/.test(component.replace("do not need to add up to 100", "")), false);
  assert.match(component, /do not need to add up to 100/);
});

test("the different-ranges warning is mounted and non-blocking", () => {
  const component = setup();
  assert.match(component, /rubricRangeWarning\(criteria\)/);
  // role="status" rather than role="alert": it is advisory and the round saves
  // either way. It must not appear in the create() refusal path.
  assert.match(component, /rubricRangeWarning\(criteria\) \? \(\s*<p className="hint setup-note" role="status"/);
  const createBody = component.slice(component.indexOf("async function create()"), component.indexOf("return ("));
  assert.equal(createBody.includes("rubricRangeWarning"), false);
  assert.equal(createBody.includes("RUBRIC_RANGE_WARNING"), false);

  // The starter rubric shares one range, so a brand-new round never opens under
  // the warning.
  const starter = component.slice(component.indexOf("const STARTER_CRITERIA"), component.indexOf("type DraftCriterion"));
  assert.equal(/min: 1, max: 5/.test(starter), true);
  assert.equal(starter.split("min: 1, max: 5").length - 1, 4);
});
