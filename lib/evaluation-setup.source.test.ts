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

  // The ceiling is NOT a value-level Zod rule — see the layering test below.
  // The schema keeps only the invariants that can never be grandfathered.
  const contract = source("types/api.ts");
  assert.match(contract, /weight: z\.number\(\)\.finite\(\)\.positive\(\)\.default\(1\)/);
});

test("the weight ceiling is layered in the route, never on the schema that reads stored rubrics", () => {
  // `rubricCriterionSchema` also parses already-stored rubric JSON through
  // `parseDecisionRubric`, which returns null for the whole rubric on any
  // failure. A `.max()` there does not reject bad input — it makes a legacy
  // round's decision scores disappear. Pinned so it cannot come back.
  const contract = source("types/api.ts");
  const criterion = contract.slice(
    contract.indexOf("export const rubricCriterionSchema"),
    contract.indexOf("export const evaluationPlanInputSchema"),
  );
  // Scoped to the weight declaration: `label` and `description` legitimately
  // carry their own `.max()` length caps, and a whole-block ban would fail on
  // those instead.
  const weightLine = criterion.split("\n").find((line) => line.includes("weight: z.number()")) ?? "";
  assert.notEqual(weightLine, "", "weight declaration not found in rubricCriterionSchema");
  assert.equal(/\.max\(/.test(weightLine), false, weightLine);
  assert.match(contract, /parseDecisionRubric/, "the reason must stay documented where the rule lives");

  const route = source("app/api/evaluations/plans/route.ts");
  assert.match(route, /import \{ rubricWeightBoundErrors \} from "@\/lib\/rubric-weight"/);
  // A create has nothing to carry forward, so it is checked against no rubric.
  assert.match(route, /if \(!input\.id\) refuseWeights\(null\);/);
  // An update is checked against the row it is about to overwrite, read
  // FOR UPDATE inside the same transaction — never a client-supplied claim.
  const transaction = route.slice(route.indexOf("$transaction"), route.indexOf("evaluationPlan.update"));
  assert.match(transaction, /FOR UPDATE/);
  assert.match(transaction, /refuseWeights\(owned\.rubric\)/);
  assert.equal(/refuseWeights\(input\./.test(route), false, "the stored side must never come from the body");
  // Same refusal shape as the schema's own, so callers see one contract.
  assert.match(route, /new ApiError\(422, "VALIDATION_ERROR", "Request validation failed\.", fieldErrors\)/);
});

test("a legacy round carries a calm note where the admin will see it", () => {
  const component = setup();
  assert.match(component, /const legacyWeights = legacyRubricWeightNote\(p\.rubric\)/);
  assert.match(component, /\{legacyWeights \? <div className="cell-sub muted">\{legacyWeights\}<\/div> : null\}/);
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

test("the round card shows the rubric itself, not just how many criteria it has", () => {
  const component = setup();
  // The gap: an organizer could read "4 criteria" and a score of 3.83, and had
  // no way to see what those criteria were or how much each one counted.
  assert.match(component, /const criteria = rubricCriterionLines\(p\.rubric\)/);
  assert.match(component, /from "@\/lib\/rubric-display"/);
  assert.match(component, /<span className="round-rubric-label">\{criterion\.label\}<\/span>/);
  assert.match(component, /<span className="round-rubric-meta">\{criterion\.meta\}<\/span>/);
  // An unreadable rubric says so rather than rendering an empty list that
  // reads as "this round scores against nothing".
  assert.match(component, /This round has no readable scoring criteria\./);

  // Read-only: the card must not have become an editor, and must not touch
  // scoring. `RoundDialog` below is the only place a rubric is authored.
  const card = component.slice(
    component.indexOf("const legacyWeights = legacyRubricWeightNote"),
    component.indexOf("{/* ---- Assign"),
  );
  assert.equal(/apiPost|fetch\(|setCriteria|onChange/.test(card), false, card.slice(0, 200));

  const css = source("components/feature.css");
  assert.match(css, /\.round-rubric-list \{/);
  assert.match(css, /\.round-rubric-meta \{/);
});

test("the round card prints the round number once, not once per part", () => {
  const component = setup();
  // "Round 1" as a heading over a stored name of "Round 1 — Program Committee"
  // — which is what both the seed and this file's own dialog default to.
  assert.match(component, /const nameSuffix = roundNameSuffix\(p\)/);
  assert.match(component, /\{nameSuffix \? <div className="cell-sub">\{nameSuffix\}<\/div> : null\}/);
  assert.match(component, /from "@\/lib\/round-label"/);
  // The dialog's default name is unchanged: it is a real, editable name, and
  // the fix is in composition rather than in renaming stored rounds.
  assert.match(component, /useState\(`Round \$\{nextOrdinal\} — Program Committee`\)/);
});

test("a coverage row names its speaker and links into the proposal's drawer", () => {
  const component = setup();
  // A row identified by title alone could not be told apart from another
  // proposal with the same title, and a coverage gap could not be acted on.
  assert.match(component, /primarySpeakerName: a\.primarySpeakerName/);
  assert.match(component, /\{a\.primarySpeakerName \?\? <span className="muted">No speaker on record<\/span>\}/);
  // The link is the shared canonical permalink, so the parameter cannot drift
  // from the one the abstracts page reads.
  assert.match(component, /<Link className="cell-title" href=\{abstractPermalink\(a\.id\)\}>\{a\.title\}<\/Link>/);
  assert.match(component, /from "@\/lib\/abstract-permalink"/);
  // A real <Link>, not an onClick on the row: middle-click, copy-link and
  // keyboard activation all have to work.
  const coverageBody = component.slice(
    component.indexOf("{coverageRows.map((a) => {"),
    component.indexOf("</tbody>"),
  );
  assert.equal(/onClick/.test(coverageBody), false, coverageBody.slice(0, 200));

  // The speaker must arrive with the projection, never through a per-row
  // query (INV-EVENT-001 / no N+1).
  const reads = source("lib/data/reads.ts");
  const setupQuery = reads.slice(
    reads.indexOf("export async function getEvaluationSetup"),
    reads.indexOf("routingUnconfigured: categories.length > 0"),
  );
  assert.match(setupQuery, /speakers: \{\s*\r?\n\s*select: \{ user: \{ select: \{ name: true \} \} \},/);
  assert.match(setupQuery, /orderBy: \[\{ isPrimary: "desc" \}, \{ userId: "asc" \}\],/);
  assert.match(setupQuery, /primarySpeakerName: a\.speakers\[0\]\?\.user\.name \?\? null/);
  // One `abstract.findMany` in this read, so the roster cannot have become a
  // query per coverage row.
  assert.equal((setupQuery.match(/prisma\.abstract\.find/g) ?? []).length, 1);
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
