import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeHtml } from "../sanitize-html";
import {
  RESOURCE_TEMPLATE_KEYS,
  RESOURCE_ASSISTANT_TEMPLATE_KEYS,
  RESOURCE_TEMPLATES,
  applyResourceTemplate,
  getResourceTemplate,
  isResourceTemplateKey,
  resourceTemplateNeedsConfirmation,
  sanitizedResourceTemplateHtml,
} from "./resource-templates";

test("the resource template catalogue is stable, allowlisted, and provider-independent", () => {
  assert.deepEqual(RESOURCE_TEMPLATE_KEYS, ["speaker-handbook", "venue-travel", "av-stage", "day-of", "blank"]);
  assert.deepEqual(RESOURCE_ASSISTANT_TEMPLATE_KEYS, ["speaker-handbook", "venue-travel", "av-stage", "day-of"]);
  assert.equal((RESOURCE_ASSISTANT_TEMPLATE_KEYS as readonly string[]).includes("blank"), false);
  assert.deepEqual(
    RESOURCE_TEMPLATES.map(({ key, label }) => [key, label]),
    [
      ["speaker-handbook", "Speaker handbook"],
      ["venue-travel", "Venue and travel guide"],
      ["av-stage", "A/V and stage requirements"],
      ["day-of", "Day-of schedule and contacts"],
      ["blank", "Blank page"],
    ],
  );
  assert.equal(new Set(RESOURCE_TEMPLATE_KEYS).size, RESOURCE_TEMPLATE_KEYS.length);

  for (const template of RESOURCE_TEMPLATES) {
    assert.equal(sanitizeHtml(template.htmlContent), template.htmlContent, template.key);
    assert.equal(sanitizedResourceTemplateHtml(template.key), template.htmlContent, template.key);
    assert.doesNotMatch(template.htmlContent, /<(?:script|style|iframe|svg)\b|\son\w+=|javascript:/i, template.key);
  }
  assert.equal(getResourceTemplate("blank").htmlContent, "");
  assert.equal(isResourceTemplateKey("speaker-handbook"), true);
  assert.equal(isResourceTemplateKey("not-allowlisted"), false);
});

test("applying a template changes only HTML and cannot mutate metadata or publish state", () => {
  const draft = {
    title: "My page",
    slug: "my-page",
    slugTouched: true,
    summary: "Keep this summary",
    htmlContent: "<p>Old content</p>",
    published: true,
  };
  const applied = applyResourceTemplate(draft, "speaker-handbook");

  assert.notEqual(applied, draft);
  assert.equal(applied.htmlContent, getResourceTemplate("speaker-handbook").htmlContent);
  assert.deepEqual(
    { ...applied, htmlContent: draft.htmlContent },
    draft,
  );
  assert.deepEqual(draft, {
    title: "My page",
    slug: "my-page",
    slugTouched: true,
    summary: "Keep this summary",
    htmlContent: "<p>Old content</p>",
    published: true,
  });
});

test("only a real non-empty replacement requires confirmation", () => {
  assert.equal(resourceTemplateNeedsConfirmation("", "speaker-handbook"), false);
  assert.equal(resourceTemplateNeedsConfirmation("   ", "speaker-handbook"), false);
  assert.equal(resourceTemplateNeedsConfirmation("<p>Custom notes</p>", "speaker-handbook"), true);
  assert.equal(
    resourceTemplateNeedsConfirmation(getResourceTemplate("speaker-handbook").htmlContent, "speaker-handbook"),
    true,
  );
  assert.equal(resourceTemplateNeedsConfirmation("<p>Custom notes</p>", "blank"), true);
});
