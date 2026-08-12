import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeHtml } from "../sanitize-html";
import {
  RESOURCE_TEMPLATE_KEYS,
  RESOURCE_ASSISTANT_TEMPLATE_KEYS,
  RESOURCE_TEMPLATES,
  applyResourceTemplate,
  getResourceTemplate,
  isResourceAssistantTemplateKey,
  isResourceTemplateKey,
  resourceHtmlNeedsReplacementConfirmation,
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
    assert.equal(template.label.trim() !== "", true, `${template.key} label`);
    assert.equal(template.description.trim() !== "", true, `${template.key} description`);
    assert.equal(new Set(template.sections.map((section) => section.key)).size, template.sections.length, template.key);
    for (const section of template.sections) {
      assert.match(section.key, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${template.key} section key`);
      assert.equal(section.heading.trim() !== "", true, `${template.key}:${section.key} heading`);
      assert.equal(template.htmlContent.includes(`>${section.heading}<`), true, `${template.key}:${section.key} HTML`);
    }
  }
  assert.equal(getResourceTemplate("blank").htmlContent, "");
  assert.deepEqual(getResourceTemplate("blank").sections, []);
  for (const key of RESOURCE_ASSISTANT_TEMPLATE_KEYS) {
    const template = getResourceTemplate(key);
    assert.equal(template.sections.length > 0, true, `${key} sections`);
    assert.match(template.htmlContent, /\[Add [^\]]+\]/, `${key} placeholders`);
  }
  assert.equal(isResourceTemplateKey("speaker-handbook"), true);
  assert.equal(isResourceTemplateKey("not-allowlisted"), false);
  assert.equal(isResourceAssistantTemplateKey("speaker-handbook"), true);
  assert.equal(isResourceAssistantTemplateKey("blank"), false);
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
  assert.equal(resourceHtmlNeedsReplacementConfirmation(""), false);
  assert.equal(resourceHtmlNeedsReplacementConfirmation("   "), false);
  assert.equal(resourceHtmlNeedsReplacementConfirmation("<p>Custom notes</p>"), true);
});
