import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * G7 — source contract for the bulk-decision toolbar and its confirmation.
 *
 * Two kinds of claim are pinned here. The first is the dialog wiring the repo
 * already standardised on and that no unit test can observe: a real `<dialog>`
 * opened with `showModal()`, named by its visible heading, and busy-gated on
 * both dismissal routes while a write is in flight (the rule PR #89 established
 * for the abstract drawer).
 *
 * The second is what the table must NOT have lost. Multi-select is a purely
 * client-side addition to a screen whose first server response is already
 * correct — the deep-linked drawer, the CSV export anchor, the `?status=` chip.
 * A regression there would be invisible to anyone testing with JavaScript on,
 * which is everyone.
 *
 * Regexes are CRLF-safe: nothing matches across a line break without allowing
 * an optional `\r`.
 */

/** Comments stripped: this lane's own prose quotes the markup it asserts on. */
const source = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");

const bar = () => source("components/bulk-decision-bar.tsx");
const table = () => source("components/abstracts-table.tsx");
const featureCss = () => source("components/feature.css");

test("the confirmation is a real <dialog>, wired the way every other one in this repo is", () => {
  const component = bar();
  assert.match(component, /useRef<HTMLDialogElement>\(null\)/);
  assert.match(component, /if \(open && !dialog\.open\) dialog\.showModal\(\);/);
  // Exactly one dialog element: a second would mean the shell was bypassed.
  assert.equal([...component.matchAll(/<dialog\b/g)].length, 1);
  // No hand-rolled overlay came back.
  assert.equal(/role="dialog"/.test(component), false);
  assert.equal(/aria-modal/.test(component), false);
  // Named by the heading on screen, not by an aria-label that can drift from it.
  assert.match(component, /aria-labelledby=\{`\$\{ids\}-title`\}/);
  assert.equal([...component.matchAll(/<h2 id=\{`\$\{ids\}-title`\}>/g)].length, 2);
  assert.match(component, /\buseId\b/);
});

test("a running batch cannot be dismissed by Escape, the backdrop, or a button", () => {
  const component = bar();
  // The response is the only place the per-item outcomes exist. Losing the
  // surface mid-write would leave an operator who just changed fifty proposals
  // with no record of which fifty.
  assert.match(component, /if \(busy\) event\.preventDefault\(\);/);
  assert.match(component, /if \(event\.target === dialogRef\.current && !busy\) dismiss\(\);/);
  // And the close path itself refuses, so no third route can slip past the two
  // handlers above.
  assert.match(component, /if \(busy\) return;/);
  assert.match(component, /disabled=\{busy \|\| pending\}/);
  assert.match(component, /disabled=\{busy\}/);
  // The apply button says what it is doing rather than going silent.
  assert.match(component, /busy \? "Applying…"/);
});

test("the dialog states the consequence before the click and the real numbers after", () => {
  const component = bar();
  // Confirm-or-explain: the prompt is composed by the pure copy module, so the
  // sentence an organizer reads is the one the unit tests pin.
  assert.match(component, /bulkDecisionPromptTitle\(prompt\)/);
  assert.match(component, /bulkDecisionPromptBody\(prompt\)/);
  assert.match(component, /bulkDecisionPromptSkipNotice\(prompt\)/);
  // And the receipt is the server's own report, never the prompt's promise
  // repeated back.
  assert.match(component, /bulkDecisionSummary\(report\)/);
  assert.match(component, /setReport\(res\.data\);/);
  // No hardcoded consequence copy in the component: it would drift from the
  // tested module the moment either changed.
  assert.equal(/No emails are sent/.test(component), false);
  assert.equal(/creates \d+ confirmed session/.test(component), false);

  // Skips are named individually, so a skipped proposal is never a silent one.
  // The grouping itself is `bulkDecisionSkipGroups`, so "no skipped row goes
  // unnamed" is a unit test rather than an eyeball over this JSX.
  assert.match(component, /bulkDecisionSkipGroups\(report, titles\)/);
  assert.match(component, /\{group\.reason\}/);
  assert.equal(/outcome === "SKIPPED"/.test(component), false);
  // The dialog does not close on success — it becomes the receipt, and only
  // "Done" clears the selection.
  assert.match(component, /onClick=\{dismiss\}/);
  assert.match(component, /onClearSelection\(\);/);
});

test("the receipt names every skipped proposal, however many share one reason", () => {
  const component = bar();
  // The render maps the whole group, so a group of six is six lines and a group
  // of a hundred is a hundred. The count answers "how many?"; only the list
  // answers "which ones do I have to open?".
  assert.match(component, /group\.ids\.map\(\(id, index\) => \(\r?$/m);
  assert.match(component, /<li key=\{id\}>\{group\.labels\[index\]\}<\/li>/);
  // By absence: no truncation branch may come back. The batch cap bounds the
  // worst case, so there is nothing here to protect the operator from.
  assert.equal(/group\.ids\.length <= \d+/.test(component), false);
  assert.equal(/group\.labels\.length <= \d+/.test(component), false);
  assert.equal(/\.slice\(0,\s*\d+\)/.test(component), false);
  assert.equal(/labels\.join\(/.test(component), false);
  assert.equal(/\+\{[^}]*\}\s*more|and \d+ more|more…/.test(component), false);
  // A hundred names is a scroll, not a wall: the group list has its own bounded
  // height so "Done" stays in the receipt.
  assert.match(component, /className="bulk-decision-skip-titles"/);
  const css = featureCss();
  assert.match(css, /\.bulk-decision-skips ul\.bulk-decision-skip-titles \{[^}]*overflow-y: auto;/);
  assert.match(css, /\.bulk-decision-skips ul\.bulk-decision-skip-titles \{[^}]*max-height:/);
});

test("the dead-button hint says which truth, and is the tested copy", () => {
  const component = bar();
  // A ticked selection with nothing writable in it must not read as an empty
  // selection, and must not claim a decision nobody made — a withdrawn row or a
  // draft is ineligible too. The sentence lives in the unit-tested module.
  assert.match(component, /bulkDecisionNothingEligibleNotice\(selected\.length\)/);
  assert.equal(/already has a decision/.test(component), false);
  assert.equal(/Every selected proposal/.test(component), false);
});

test("the toolbar appears only with a selection, and its eligibility read is preview only", () => {
  const component = bar();
  assert.match(component, /if \(selected\.length === 0\) return null;/);
  assert.match(component, /proposalCount\(selected\.length\)\} selected/);
  // The client's eligibility split is the same predicate the route runs, so the
  // prompt's arithmetic matches the result's — but it is a preview, never an
  // authorization: the server re-reads every status under that abstract's lock.
  assert.match(component, /bulkDecisionEligibility\(row\.status/);
  assert.match(component, /disabled=\{eligible\.length === 0\}/);
  // One endpoint, and it is the bulk one.
  assert.match(component, /apiPost<BulkDecisionReport>\(/);
  assert.match(component, /"\/api\/evaluations\/decisions\/bulk"/);
  assert.equal([...component.matchAll(/apiPost</g)].length, 1);
  // The table's own data is re-read after a batch, so the rows reflect it.
  assert.match(component, /startTransition\(\(\) => router\.refresh\(\)\);/);
});

test("the POST carries every selected id, never the eligible subset", () => {
  const component = bar();
  // The request body is built by the tested helper, from `selected` — the whole
  // ticked selection, in order. The report has one entry per requested id, so an
  // id withheld here is a row the operator ticked and gets no answer about.
  assert.match(component, /bulkDecisionRequestBody\(target, selected\),?\r?$/m);
  // By absence: nothing in this file may derive a request from the eligible
  // split. Any of these shapes would silently shrink the receipt.
  assert.equal(/abstractIds:\s*eligible\b/.test(component), false);
  assert.equal(/abstractIds:\s*[^\n]*\.filter\(/.test(component), false);
  assert.equal(/eligible\.map\(/.test(component), false);
  assert.equal(/bulkDecisionRequestBody\([^)]*eligible/.test(component), false);
  // `eligible` survives only as copy and as the disabled gate: it counts, it
  // never feeds the wire.
  const uses = [...component.matchAll(/\beligible\b[^\n]*/g)].map((m) => m[0]);
  for (const use of uses) {
    assert.equal(
      /\.map\(|abstractIds|apiPost|bulkDecisionRequestBody/.test(use),
      false,
      `eligible must not reach the request: ${use}`,
    );
  }
});

test("select-all means all VISIBLE, and the selection survives a filter change", () => {
  const component = table();
  // Scoped to `rows` — what the chip and the search left on screen — never to
  // `abstracts` and never to the stored total. Anything else would let one
  // click reach proposals the operator cannot see.
  assert.match(component, /for \(const row of rows\) \{/);
  assert.match(component, /const allVisibleSelected = rows\.length > 0 && visibleSelectedCount === rows\.length;/);
  assert.match(component, /aria-label=\{`Select all \$\{rows\.length\} proposals shown`\}/);
  // Keyed by id, so a selection built under one chip is still one selection
  // after the chip changes. An index-keyed selection would silently re-point.
  assert.match(component, /useState<ReadonlySet<string>>\(\(\) => new Set\(\)\)/);
  assert.match(component, /selectedIds\.has\(a\.id\)/);
  // Partial selection is a third state and only the DOM property carries it.
  assert.match(component, /box\.indeterminate = visibleSelectedCount > 0 && !allVisibleSelected;/);
  // A native checkbox, not a painted one: `.switch` in this repo's own CSS is
  // the cautionary tale about decoration intercepting the control's clicks.
  assert.equal([...component.matchAll(/type="checkbox"/g)].length, 2);
});

test("multi-select changed nothing the server already rendered", () => {
  const component = table();
  // Still exactly one <dialog> in this file: the proposal drawer. The bulk
  // confirmation lives in its own component precisely so this stays true.
  assert.equal([...component.matchAll(/<dialog\b/g)].length, 1);
  // The deep-linked drawer is still server-rendered open.
  assert.match(component, /open=\{serverOpen \|\| undefined\}/);
  // The CSV export is still a plain anchor the browser handles, not a fetch.
  assert.match(component, /<a\s+className="ghost-button"\s+href=\{href\}/);
  assert.match(component, /const href = selectedPlan\r?$/m);
  assert.match(component, /\/api\/admin\/abstracts\/export/);
  // Selection is client state only: no checkbox may push a query param, refetch
  // the page, or post anything. The bar owns the only write on this screen.
  // The whole selection machinery, bounded by the round-selector callback that
  // legitimately does push — so the slice cannot pass by swallowing nothing.
  const selectionBlock = component.slice(
    component.indexOf("const bulkSelection"),
    component.indexOf("function changeDecisionPlan"),
  );
  assert.ok(selectionBlock.includes("function toggleVisible"), "the slice must cover select-all");
  assert.equal(/router\.(push|refresh)|apiPost|fetch\(/.test(selectionBlock), false);
  // And nothing about the selection reaches the server-resolved initial props.
  assert.equal(/initialSelectedIds|\?selected=|searchParams.*selectedIds/.test(component), false);
});

test("the bulk bar sits between the toolbar and the table, and its styles exist", () => {
  const component = table();
  // Rendered after the search/export toolbar and before the table body, so it
  // never displaces the overflow notice or the chips above it.
  assert.ok(component.indexOf("<ExportResultsLink") < component.indexOf("<BulkDecisionBar"));
  assert.ok(component.indexOf("<BulkDecisionBar") < component.indexOf("abstracts.length === 0 ?"));
  assert.match(component, /onClearSelection=\{\(\) => setSelectedIds\(new Set\(\)\)\}/);

  const css = featureCss();
  for (const selector of [
    ".row-select-cell", ".row-select", ".bulk-decision-bar", ".bulk-decision-count",
    ".bulk-decision-dialog-body", ".bulk-decision-actions", ".bulk-decision-skips",
  ]) {
    assert.ok(css.includes(selector), `${selector} must be defined in feature.css`);
  }
  // Padding on the body, never on the dialog: `event.target === dialog` is only
  // a backdrop click if the dialog has no padding of its own to click on.
  assert.match(css, /\.app-dialog\.bulk-decision-dialog \{[^}]*padding: 0;/);
  assert.match(css, /\.bulk-decision-dialog-body \{[^}]*padding: 24px 26px;/);
});
