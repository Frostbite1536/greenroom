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
const frontendSmoke = () => source("scripts/_frontend-smoke.mjs");

test("the frontend smoke scopes the missing-score assertion to its exact SSR row", () => {
  const smoke = frontendSmoke();
  assert.match(smoke, /const tableRowContaining = \(html, marker\) =>/);
  assert.match(smoke, /const partialReviewRow = tableRowContaining\(partialRoundPage\.text, partialReview\.title\);/);
  assert.match(smoke, /partialReviewRowText\.includes\(partialReview\.title\)/);
  assert.match(smoke, /partialReviewRowText\.includes\("No included reviews"\)/);
  assert.match(smoke, /partialReviewRowText\.includes\("0\/1 included"\)/);
  assert.match(smoke, /!partialReviewRowText\.includes\("0\.00"\)/);
  assert.doesNotMatch(smoke, /!partialRoundText\.includes\("0\.00"\)/);
});

test("the frontend smoke owns a direct repo-local Next CLI process", () => {
  const smoke = frontendSmoke();
  assert.match(smoke, /resolve\(process\.cwd\(\), "node_modules", "next", "dist", "bin", "next"\)/);
  assert.match(smoke, /spawn\(process\.execPath, \[nextCli, "start", "-p", PORT\]/);
  assert.match(smoke, /shell: false/);
  assert.doesNotMatch(smoke, /spawn\("npx"/);
  assert.match(smoke, /server\.kill\("SIGTERM"\)/);
  assert.match(smoke, /await waitForServerExit\(5_000\)/);
  assert.match(smoke, /spawnSync\("taskkill", \["\/F", "\/T", "\/PID", String\(serverPid\)\]/);
});

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

test("every submitted status has a filter chip, including Withdrawn", () => {
  const component = table();
  // The chip vocabulary moved to `lib/abstract-status` when the `/admin`
  // dashboard funnel began linking into these chips: one list, so a segment
  // there cannot name a chip that does not exist here. The table must render
  // that list rather than keep a second copy.
  assert.match(component, /const TABS = ABSTRACT_STATUS_TABS;/);
  const vocabulary = source("lib/abstract-status.ts");
  const tabs = vocabulary.slice(
    vocabulary.indexOf("export const ABSTRACT_STATUS_TABS"),
    vocabulary.indexOf("export const ABSTRACT_FUNNEL_STATUSES"),
  );
  // The gap this closes: a speaker withdrawing mid-review was loaded, rendered
  // under "All", and reachable by no filter at all.
  assert.match(tabs, /\{ key: "WITHDRAWN", label: "Withdrawn" \}/);

  // Every chip key must be a real status, because the filter is an equality
  // test against `a.status` — a key naming no status shows an empty table
  // rather than failing. `ALL` is the deliberate exception.
  const statuses = vocabulary.slice(
    vocabulary.indexOf("export const ABSTRACT_STATUS_META"),
    vocabulary.indexOf("export const ABSTRACT_STATUS_ALL"),
  );
  // The unfiltered chip is the named `ABSTRACT_STATUS_ALL` constant, not a
  // string literal, so it is asserted separately from the seven statuses.
  assert.match(tabs, /\{ key: ABSTRACT_STATUS_ALL, label: "All" \}/);
  const chipKeys = [...tabs.matchAll(/key: "([A-Z_]+)"/g)].map((match) => match[1]);
  assert.ok(chipKeys.length >= 7, `got ${chipKeys.length} status chips`);
  for (const key of chipKeys) {
    if (key === "ALL") continue;
    assert.match(statuses, new RegExp(`^\\s*${key}: \\{`, "m"), `${key} is not a rendered status`);
  }
  // And the reverse: no status may be left without a way to reach it.
  const statusKeys = [...statuses.matchAll(/^\s{2}([A-Z_]+): \{ label:/gm)].map((match) => match[1]);
  assert.ok(statusKeys.includes("WITHDRAWN"));
  for (const status of statusKeys) {
    assert.ok(chipKeys.includes(status), `${status} has no filter chip`);
  }

  // Filtering follows the existing pattern exactly: one equality test against
  // the server-rendered rows, with the count read from the same collection.
  assert.match(component, /\.filter\(\(a\) => \(tab === "ALL" \? true : a\.status === tab\)\)/);
  assert.match(component, /for \(const a of abstracts\) c\[a\.status\] = \(c\[a\.status\] \?\? 0\) \+ 1;/);
  // No chip may become a server round trip; the page is server-rendered once.
  const chipBlock = component.slice(component.indexOf("{TABS.map"), component.indexOf("{hasMore ?"));
  assert.equal(/router\.(push|refresh)|apiPost|fetch\(/.test(chipBlock), false);
  // The accessible name still carries the count, as the other chips do.
  assert.match(component, /aria-label=\{`\$\{t\.label\}: \$\{counts\[t\.key\] \?\? 0\} \$\{loadedLabel\}`\}/);
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
