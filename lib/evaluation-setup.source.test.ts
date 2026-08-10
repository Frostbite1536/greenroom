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

test("every coverage column header is a real button inside its th", () => {
  const component = setup();
  // Five columns, one button each — not a click handler on the <th>, which
  // would be unreachable by keyboard and expose no role.
  assert.match(component, /COVERAGE_COLUMNS\.map\(\(\{ column, label \}\) => \(/);
  assert.match(component, /<th key=\{column\} scope="col" aria-sort=\{coverageAriaSort\(coverageSort, column\)\}>/);
  assert.match(component, /<button\s+type="button"\s+className="sort-header"/);
  assert.match(component, /onClick=\{\(\) => setCoverageSort\(\(s\) => nextCoverageSort\(s, column\)\)\}/);
  const columns = component.slice(
    component.indexOf("const COVERAGE_COLUMNS"),
    component.indexOf("function coverageSortDirection"),
  );
  for (const label of ["Proposal", "Category", "Status", "Reviewers", "Reviews done"]) {
    assert.match(columns, new RegExp(`label: "${label}"`));
  }
  // No stray keydown shim: activation is the platform's, so Enter and Space
  // both work without a handler that could drift from click.
  assert.equal(/onKeyDown/.test(component), false);
});

test("sort direction is a shape and a sentence, never colour alone", () => {
  const component = setup();
  assert.match(component, /<ArrowUpDown size=\{13\} className="sort-indicator" aria-hidden="true" \/>/);
  assert.match(component, /<ArrowUp size=\{13\} className="sort-indicator active" aria-hidden="true" \/>/);
  assert.match(component, /<ArrowDown size=\{13\} className="sort-indicator active" aria-hidden="true" \/>/);
  assert.match(component, /<span className="sr-only">/);
  assert.match(component, /", sorted ascending" : ", sorted descending"/);

  // The interactive target is at least 32px, and the indicator's colour change
  // is explicitly secondary to the arrow shape.
  const css = source("components/feature.css");
  assert.match(css, /\.sort-header \{[^}]*min-height: 32px/);
  assert.match(css, /\.sort-header:focus-visible \{[^}]*outline:/);
});

test("coverage sorting is local to the loaded rows and starts unsorted", () => {
  const component = setup();
  assert.match(component, /useState<CoverageSortState>\(null\)/);
  assert.match(component, /return sortCoverageRows\(rows, coverageSort\)/);
  // The table body reads the sorted rows, not the raw projection.
  assert.match(component, /\{coverageRows\.map\(\(a\) => \{/);
  // Sorting must not become a server round trip: no refresh, push or fetch is
  // wired to the sort control.
  const sortSection = component.slice(
    component.indexOf("Review coverage — round"),
    component.indexOf("</tbody>"),
  );
  assert.equal(/router\.(refresh|push)|apiPost|fetch\(/.test(sortSection), false);
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
