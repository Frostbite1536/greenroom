import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../components/resource-manager.tsx", import.meta.url), "utf8");

test("resource templates replace only HTML and confirm before replacing non-empty content", () => {
  assert.match(source, /RESOURCE_TEMPLATES/);
  assert.match(source, /isResourceTemplateKey\(event\.target\.value\)/);
  assert.match(source, /resourceTemplateNeedsConfirmation\(draft\.htmlContent, key\)/);
  assert.match(source, /window\.confirm\([\s\S]*replace the HTML currently in this editor/i);
  assert.match(source, /onChange\(applyResourceTemplate\(draft, key\)\)/);
  assert.match(source, /key=\{editing \? `resource:\$\{editing\.id \?\? "new"\}` : "resource:closed"\}/);
  assert.doesNotMatch(source, /applyResourceTemplate\([^\n]+title/);
});

test("the preview renders only the existing sanitizer's output and the tabs are keyboard operable", () => {
  assert.match(source, /const previewDecision = draft\.htmlContent\.trim\(\) === "" \? null : prepareResourceHtml\(draft\.htmlContent\)/);
  assert.match(source, /previewDecision\.allowed \? \([\s\S]*dangerouslySetInnerHTML=\{\{ __html: previewDecision\.html \}\}/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML=\{\{ __html: draft\.htmlContent \}\}/);
  assert.match(source, /role="tablist"/);
  assert.equal([...source.matchAll(/role="tab"/g)].length, 2);
  assert.equal([...source.matchAll(/role="tabpanel"/g)].length, 2);
  for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) assert.match(source, new RegExp(`"${key}"`));
  assert.match(source, /htmlTabRef\.current\?\.focus\(\)/);
  assert.match(source, /previewTabRef\.current\?\.focus\(\)/);
  assert.match(source, /role="status">Nothing to preview yet/);
  assert.match(source, /role="status">\{previewDecision\.message\}/);
});
