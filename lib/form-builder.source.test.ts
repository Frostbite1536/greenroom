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

test("the shared switch's decoration cannot intercept its own checkbox", () => {
  const css = source("components/feature.css");
  // Both spans are absolutely positioned after the input, so they are the hit
  // target for anything aiming at the control unless they opt out.
  assert.match(css, /\.switch \.track,\s*\.switch \.thumb \{[^}]*pointer-events:\s*none/);

  const ui = source("components/ui.tsx");
  assert.match(ui, /<span className="track" aria-hidden="true" \/>/);
  assert.match(ui, /<span className="thumb" aria-hidden="true" \/>/);
});
