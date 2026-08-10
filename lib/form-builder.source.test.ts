/**
 * Source regressions for the builder's layout and stacking contract.
 *
 * These rules are geometry, not behaviour, so no unit test can exercise them
 * through the DOM here. What can be locked is the contract that makes the
 * geometry safe: the editor column outranks the sticky preview, neither the
 * preview nor a field row can overflow sideways, and the switch's decorative
 * spans do not sit in front of their own checkbox.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** The declarations inside one top-level rule, by selector, ignoring media blocks. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `expected a rule for ${selector}`);
  return match![2];
}

test("the builder's editor column paints above the sticky preview it sits beside", () => {
  const css = source("components/feature.css");

  // Both siblings are positioned (sticky), so paint order is DOM order unless
  // the editor is promoted. Without this an overlap intercepts editor clicks.
  const panel = rule(css, ".builder-panel");
  assert.match(panel, /position:\s*relative/);
  assert.match(panel, /z-index:\s*1\b/);

  const preview = rule(css, ".builder-preview");
  assert.match(preview, /position:\s*sticky/);
  assert.match(preview, /z-index:\s*0\b/);
  // A grid item defaults to `min-width: auto`, which lets its min-content size
  // push the box past its fixed track and over the editor column.
  assert.match(preview, /min-width:\s*0\b/);
});

test("builder rows wrap instead of overflowing the editor column", () => {
  const css = source("components/feature.css");
  assert.match(rule(css, ".field-editor-head"), /flex-wrap:\s*wrap/);
  assert.match(rule(css, ".builder-preview .card"), /max-width:\s*100%/);

  const builder = source("components/form-builder.tsx");
  // The Add field header and the per-field control cluster (Required, reorder,
  // delete) are the two rows whose min-content width exceeded the column.
  assert.match(builder, /className="row wrap"[^>]*justifyContent: "space-between"[\s\S]{0,400}?Add field/);
  assert.match(builder, /className="row wrap" style=\{\{ gap: 4 \}\}[\s\S]{0,600}?label="Required"/);
});

test("the preview column is dropped before the editor column is squeezed", () => {
  const css = source("components/feature.css");
  const collapse = css.match(/@media \(max-width: 1280px\) \{([\s\S]*?)\n\}/);
  assert.ok(collapse, "expected the builder to collapse at 1280px");
  assert.match(collapse![1], /\.builder \{[^}]*grid-template-columns:\s*1fr/);
  assert.match(collapse![1], /\.builder-preview \{[^}]*display:\s*none/);
  // `flex-direction` was inert on a `display: grid` element; the collapsed nav
  // has to actually declare the layout it wants.
  assert.match(collapse![1], /\.builder-nav \{[^}]*display:\s*flex/);
  assert.doesNotMatch(collapse![1], /\.builder-nav \{[^}]*flex-direction:\s*row/);
});

test("the builder never derives an option value from its label", () => {
  const builder = source("components/form-builder.tsx");
  // The old editor rebuilt every value from its wording on each keystroke.
  assert.doesNotMatch(builder, /value: label\.toLowerCase\(\)/);
  assert.doesNotMatch(builder, /options: e\.target\.value\s*\n?\s*\.split\("\\n"\)/);
  assert.match(builder, /relabelOption\(options, i, e\.target\.value\)/);
  assert.match(builder, /addOption\(options\)/);
  // A stored value is shown, not edited, so it cannot move under an answer.
  assert.match(builder, /<code className="hint"[^>]*>\{option\.value\}<\/code>/);
});

test("the builder mirrors the server's shape refusals instead of restating them", () => {
  const builder = source("components/form-builder.tsx");
  assert.match(builder, /from "@\/lib\/services\/form-shape-validation"/);
  assert.match(builder, /findFormShapeIssues\(toShapeFields\(draft\)\)/);
  assert.match(builder, /formShapeFieldErrors\(/);
  // Field-scoped server errors are translated onto the editor's own keys, or
  // they land under a key nothing renders and the save fails silently.
  assert.match(builder, /function byLocalId\(/);
  assert.match(builder, /const inline = byLocalId\(res\.error\.fieldErrors\)/);
  assert.match(builder, /setOpenField\(offending\.slice\("field\."\.length\)\)/);
  assert.doesNotMatch(builder, /firstFieldErrors/);
});

test("the rule editor offers the server's built-in sources and seeds a valid rule", () => {
  const builder = source("components/form-builder.tsx");
  assert.match(builder, /ruleSources\(/);
  assert.match(builder, /<optgroup label="Built-in questions">/);
  assert.match(builder, /<optgroup label="Questions on this form">/);
  // The old seed posted `value: ""`, which the server refuses with
  // FORM_LOGIC_VALUE_MISSING on the author's very first Save.
  assert.doesNotMatch(builder, /operator: "equals", value: ""/);
  assert.match(builder, /rules: \[defaultRule\(sources\[0\]\)\]/);
  assert.match(builder, /missingValue \? \(/);
  // Adding logic no longer requires a second custom question to exist.
  assert.doesNotMatch(builder, /disabled=\{others\.length === 0\}/);
});

test("the public form and the preview both answer the built-in sources", () => {
  const cfp = source("components/cfp-form.tsx");
  assert.match(cfp, /withBuiltInAnswers\(answers, \{ title, abstract, format, categoryId, speakers \}\)/);
  const builder = source("components/form-builder.tsx");
  // Same helper, same call, so preview and public form cannot drift.
  assert.match(builder, /withBuiltInAnswers\(answers, previewBuiltInAnswers\(builtIns\)\)/);
  // Both start on the same format, so the preview is not lying about the first
  // paint a submitter gets.
  assert.match(cfp, /useState\(DEFAULT_SESSION_FORMAT\)/);
  assert.match(builder, /initialPreviewBuiltIns\(DEFAULT_SESSION_FORMAT\)/);
});

test("the preview renders a control for every built-in the rule picker offers", () => {
  const builder = source("components/form-builder.tsx");
  // A source with no control would sit at an empty default forever, and the
  // preview would disagree with the public form for that rule (PR #67).
  const preview = builder.slice(builder.indexOf("function Preview("));
  for (const label of ["Session title", "Abstract", "Session format", "Topic category", "Speakers added"]) {
    assert.ok(preview.includes(label), `the preview has no control for ${label}`);
  }
  assert.match(preview, /patchBuiltIn\(\{ abstract: e\.target\.value \}\)/);
  assert.match(preview, /patchBuiltIn\(\{ categoryId: e\.target\.value \}\)/);
  assert.match(preview, /patchBuiltIn\(\{ speakerCount: Number\(e\.target\.value\) \}\)/);
  // An event with no categories says so rather than showing an empty picker.
  assert.match(preview, /This event has no categories yet/);
});

test("the builder page loads the event categories the preview and rule picker need", () => {
  const reads = source("lib/data/reads.ts");
  const builderRead = reads.slice(reads.indexOf("export async function getFormForBuilder"));
  // Bounded and event-scoped like every other operator projection, id+name only.
  assert.match(builderRead, /prisma\.category\.findMany\(\{\s*where: \{ eventId: ctx\.eventId \}/);
  assert.match(builderRead, /select: \{ id: true, name: true \}/);
  assert.match(builderRead, /assertEventQueryBound\(categories, OPERATOR_QUERY_LIMITS\.settingsCategories/);

  const page = source("app/(app)/admin/forms/[formId]/page.tsx");
  assert.match(page, /categories=\{result\.categories\}/);
});

test("only the builder preview renders fields under the `preview-` id prefix", () => {
  // The smoke tells "the preview rendered this question" apart from "the editor
  // list named it" by looking for `id="preview-<key>"`. That only discriminates
  // while this prefix stays unique to the preview.
  const builder = source("components/form-builder.tsx");
  assert.match(builder, /idPrefix="preview"/);
  assert.match(source("components/field-renderer.tsx"), /const id = `\$\{idPrefix\}-\$\{field\.key\}`/);
  for (const [path, prefix] of [
    ["components/cfp-form.tsx", "cfp"],
    ["app/(app)/portal/submissions/[abstractId]/submission-editor.tsx", "sub"],
    ["app/(app)/portal/tasks/[taskId]/task-form.tsx", "task"],
  ] as const) {
    assert.match(source(path), new RegExp(`idPrefix="${prefix}"`));
    assert.doesNotMatch(source(path), /idPrefix="preview"/);
  }
  // The editor list names every question regardless of the preview, which is
  // exactly why a page-wide search cannot stand in for a scoped one.
  assert.match(builder, /\{field\.label \|\| "Untitled question"\}/);
});

test("the shared switch's decoration cannot intercept its own checkbox", () => {
  const css = source("components/feature.css");
  // Both spans are absolutely positioned after the input, so they are the hit
  // target for anything aiming at the control unless they opt out.
  assert.match(css, /\.switch \.track,\s*\.switch \.thumb \{[^}]*pointer-events:\s*none/);

  const ui = source("components/ui.tsx");
  assert.match(ui, /<span className="track" aria-hidden="true" \/>/);
  assert.match(ui, /<span className="thumb" aria-hidden="true" \/>/);
});
