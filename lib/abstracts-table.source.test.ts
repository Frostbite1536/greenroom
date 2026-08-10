/**
 * Source contract for the admin abstracts table's decision-score sort (ABS-10).
 *
 * The comparator is covered by decision-score-sort.test.ts. What is pinned here
 * is the wiring around it: that the sort is local to the loaded page, that the
 * overflow notice still says so, that the column with the control is the score
 * column and not the review-count column beside it, and that nothing on this
 * screen implies sorting changed the decision round or which reviews count.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const table = () => source("components/abstracts-table.tsx");

test("the decision-score header is a real button in its th, with aria-sort only when sorted", () => {
  const component = table();
  assert.match(component, /<th scope="col" aria-sort=\{decisionScoreAriaSort\(scoreSort\)\}>/);
  assert.match(component, /<button\s+type="button"\s+className="sort-header"/);
  assert.match(component, /onClick=\{\(\) => setScoreSort\(\(s\) => nextDecisionScoreSort\(s\)\)\}/);
  // aria-sort is computed, never hardcoded onto an inactive header.
  assert.equal(/aria-sort="(none|ascending|descending)"/.test(component), false);
  // Keyboard activation is the platform's; no parallel key handler to drift.
  assert.equal(/onKeyDown/.test(component), false);
  // Shape plus a sentence, not colour alone.
  assert.match(component, /<ArrowUpDown size=\{13\} className="sort-indicator" aria-hidden="true" \/>/);
  assert.match(component, /", sorted ascending" : ", sorted descending"/);
  assert.match(component, /<span className="sr-only">/);
});

test("decision-review-count sorting is deliberately absent", () => {
  const component = table();
  // Out of this lane by name (§3.2). The header stays a plain label.
  assert.match(component, /<th>Decision reviews<\/th>/);
  // Up to the score column's control, not up to its label: the button's own
  // text is "Decision score", so slicing on the label would swallow it.
  const reviewsHeader = component.slice(
    component.indexOf("<th>Decision reviews</th>"),
    component.indexOf("decisionSummary.selectedPlan ? ("),
  );
  assert.equal(reviewsHeader.includes("<button"), false);
  assert.equal(/includedReviews|completedAssignments/.test(component.slice(
    component.indexOf("const rows = useMemo"),
    component.indexOf("}, [abstracts, tab, q, scoreSort]);"),
  )), false, "the sort key must be the score, not the review counts");
});

test("without a decision round no sort control is offered", () => {
  const component = table();
  assert.match(component, /decisionSummary\.selectedPlan \? \(/);
  assert.match(component, /\) : \(\s*\/\/ Without a round every cell reads "No review round"/);
  assert.match(component, /<th>Decision score<\/th>/);
});

test("sorting is local to the loaded page and the overflow notice still says so", () => {
  const component = table();
  assert.match(component, /useState<DecisionScoreSortState>\(null\)/);
  // The notice is preserved and now names sorting alongside tabs and search.
  assert.match(component, /Tabs, search and sorting cover only these loaded proposals/);
  assert.match(component, /it does not rank every stored proposal/);
  assert.match(component, /Showing first \{abstracts\.length\} of \{total\} proposals/);

  // No server round trip: sorting must not push a query param or refetch.
  const rowsMemo = component.slice(
    component.indexOf("const rows = useMemo"),
    component.indexOf("}, [abstracts, tab, q, scoreSort]);"),
  );
  assert.equal(/router\.(push|refresh)|apiPost|fetch\(/.test(rowsMemo), false);
  // The score is passed through as projected — no `?? 0` anywhere near it.
  assert.match(component, /weightedAverage: a\.decisionSummary\?\.weightedAverage \?\? null/);
  assert.equal(/weightedAverage[^\n]*\?\?\s*0/.test(component), false);
});

test("nothing implies that sorting changed the round or the included-review rules", () => {
  const component = table();
  // The round control's own copy is the only place either subject is
  // explained, and it is unchanged.
  assert.match(
    component,
    /This event has several review rounds; the newest one is shown\. Decision scores include only valid, completed reviews from the selected round\./,
  );
  assert.match(
    component,
    /Decision scores include only valid, completed reviews from this round\./,
  );
  // The sort control sits in the table head and says nothing about rounds or
  // inclusion.
  const head = component
    .slice(component.indexOf("<thead>"), component.indexOf("</thead>"))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.equal(/round|included|includes/i.test(head), false, head);

  // PR #65's merged newest-round default must survive: the selected plan still
  // comes from the server summary, not from sort state.
  assert.match(component, /value=\{selectedPlan\?\.id \?\? ""\}/);
  assert.equal(/setScoreSort[^\n]*plan/i.test(component), false);
});
