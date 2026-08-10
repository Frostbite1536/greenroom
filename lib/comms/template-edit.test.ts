import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emailTemplateUpdateSchema,
  extractTemplateVariables,
  previewTemplate,
  sanitizeTemplateBody,
  templateTriggerPatch,
  unknownTemplateVariables,
  KNOWN_TEMPLATE_VARIABLES,
  missingRequiredTemplateVariables,
  storedTemplateDefects,
} from "./template-edit";
import { renderEmailTemplate } from "./reminders";
import { buildSubmissionReceipt } from "./notifications";
import { DEMO_EMAIL_TEMPLATES } from "@/lib/demo/seed";

test("placeholders are found the same way the renderer finds them", () => {
  assert.deepEqual(
    extractTemplateVariables("Hi {{speakerName}}", "<p>{{ talkTitle }} in {{roomName}}</p>"),
    ["roomName", "speakerName", "talkTitle"],
  );
  // Not a placeholder: single braces, or a name that starts with a digit.
  assert.deepEqual(extractTemplateVariables("{notAVar} {{1bad}}"), []);
});

test("unknown placeholders are flagged because they render as nothing", () => {
  assert.deepEqual(unknownTemplateVariables("Hi {{speakerName}}, see {{hotelName}}"), ["hotelName"]);
  assert.deepEqual(unknownTemplateVariables("Hi {{speakerName}} about {{talkTitle}}"), []);
  // Every advertised variable must actually be known, or the UI would lie.
  for (const name of KNOWN_TEMPLATE_VARIABLES) {
    assert.deepEqual(unknownTemplateVariables(`{{${name}}}`), [], name);
  }
});

test("the stored body is sanitized, and the operator is told when markup was dropped", () => {
  const dangerous = sanitizeTemplateBody("<p>Hello</p><script>alert(1)</script>");
  assert.equal(dangerous.changed, true);
  assert.doesNotMatch(dangerous.htmlBody, /script/i);

  const clean = sanitizeTemplateBody("<p>Hello <strong>speaker</strong></p>");
  assert.equal(clean.changed, false);
  assert.match(clean.htmlBody, /<strong>speaker<\/strong>/);
});

test("an event handler or javascript: link cannot survive a save", () => {
  const saved = sanitizeTemplateBody('<p onclick="steal()">Hi</p><a href="javascript:alert(1)">click</a>');
  assert.doesNotMatch(saved.htmlBody, /onclick/i);
  assert.doesNotMatch(saved.htmlBody, /javascript:/i);
  assert.equal(saved.changed, true);
});

test("preview substitutes sample data and escapes it", () => {
  const preview = previewTemplate({
    subject: "Your session at {{eventName}}",
    htmlBody: "<p>Hi {{speakerName}}, {{talkTitle}} is in {{roomName}}.</p>",
  });
  assert.equal(preview.subject, "Your session at Forward 2026");
  assert.match(preview.html, /Hi Sofia Marques, Scaling Vector Search is in Hall A\./);
});

test("preview cannot execute markup the real email would strip", () => {
  const preview = previewTemplate({ subject: "s", htmlBody: "<p>ok</p><img src=x onerror=alert(1)>" });
  assert.doesNotMatch(preview.html, /onerror|<img/i);
});

test("preview and the real renderer agree on the same input", () => {
  const template = { subject: "Hello {{speakerName}}", htmlBody: "<p>{{talkTitle}} &amp; friends</p>" };
  const preview = previewTemplate(template);
  const rendered = renderEmailTemplate(template, { speakerName: "Sofia Marques", talkTitle: "Scaling Vector Search" });
  assert.equal(preview.subject, rendered.subject);
  assert.equal(preview.html, rendered.html);
});

test("an unsupplied placeholder renders empty in both preview and the real email", () => {
  const template = { subject: "s", htmlBody: "<p>Hi {{hotelName}}!</p>" };
  assert.match(previewTemplate(template).html, /Hi !/);
  assert.match(renderEmailTemplate(template, {}).html, /Hi !/);
});

test("the update schema refuses empty content and oversized bodies", () => {
  assert.equal(emailTemplateUpdateSchema.safeParse({ subject: "Hi", htmlBody: "<p>x</p>" }).success, true);
  assert.equal(emailTemplateUpdateSchema.safeParse({ subject: "   ", htmlBody: "<p>x</p>" }).success, false);
  assert.equal(emailTemplateUpdateSchema.safeParse({ subject: "Hi", htmlBody: "" }).success, false);
  assert.equal(emailTemplateUpdateSchema.safeParse({ subject: "Hi", htmlBody: "x".repeat(20_001) }).success, false);
  // `key` is deliberately not editable: reminders address templates by it.
  const parsed = emailTemplateUpdateSchema.safeParse({ subject: "Hi", htmlBody: "<p>x</p>", key: "renamed" });
  assert.equal(parsed.success && "key" in parsed.data, false);
});

test("optional template triggers use true PATCH presence semantics", () => {
  assert.deepEqual(templateTriggerPatch(undefined), {});
  assert.deepEqual(templateTriggerPatch(null), { trigger: null });
  assert.deepEqual(templateTriggerPatch("   "), { trigger: null });
  assert.deepEqual(templateTriggerPatch(" session.scheduled "), { trigger: "session.scheduled" });
});

test("reviewer-invite template edits retain the trusted invite URL placeholder", () => {
  assert.deepEqual(missingRequiredTemplateVariables("reviewer-invite", "Invite", "<p>Open {{inviteUrl}}</p>"), []);
  assert.deepEqual(missingRequiredTemplateVariables("reviewer-invite", "Invite", "<p>Open your workspace</p>"), ["inviteUrl"]);
  assert.deepEqual(missingRequiredTemplateVariables("task.reminder", "Invite", "<p>Open your workspace</p>"), []);
});

test("the submission receipt may not lose the proposal title it exists to confirm", () => {
  // C21 made this template really drive the send, so the required-variable
  // boundary now has to protect the one fact a receipt must carry.
  assert.deepEqual(
    missingRequiredTemplateVariables("cfp-submitted", "We received {{talkTitle}}", "<p>Hi {{speakerName}}</p>"),
    [],
  );
  assert.deepEqual(
    missingRequiredTemplateVariables("cfp-submitted", "We received your proposal", "<p>Hi {{speakerName}}</p>"),
    ["talkTitle"],
  );
  // Hardcoding the event name stays a legitimate editorial choice.
  assert.deepEqual(
    missingRequiredTemplateVariables("cfp-submitted", "Forward 2026", "<p>Thanks for {{talkTitle}}</p>"),
    [],
  );
});

/**
 * A stored row is only trustworthy if it passed the edit contract. A row edited
 * before its template became load-bearing never did, so the send path re-checks
 * with this predicate rather than trusting the database.
 */
const RECEIPT_VARIABLES = ["speakerName", "eventName", "talkTitle"];

function receiptDefects(subject: string, htmlBody: string) {
  return storedTemplateDefects({
    key: "cfp-submitted",
    subject,
    htmlBody,
    suppliedVariables: RECEIPT_VARIABLES,
  });
}

test("the seeded submission receipt satisfies the contract its send path re-checks", () => {
  // Regression guard: if this ever fails, every receipt silently falls back to
  // fixed copy and the console's "editing this works" claim goes false again.
  const seeded = DEMO_EMAIL_TEMPLATES.find((template) => template.key === "cfp-submitted");
  assert.ok(seeded);
  assert.deepEqual(receiptDefects(seeded.subject, seeded.htmlBody), []);
});

test("a legacy stored row that never passed the edit contract is reported, not rendered", () => {
  // Written before `cfp-submitted` required the title — valid then, lossy now.
  assert.deepEqual(
    receiptDefects("We got your proposal", "<p>Hi {{speakerName}}, thanks.</p>"),
    ["missing_required"],
  );
  // Nothing supplies `portalLink`, so it would render as a silent blank.
  assert.deepEqual(
    receiptDefects("We got {{talkTitle}}", "<p>Hi {{speakerName}} — {{portalLink}}</p>"),
    ["unfilled_placeholder"],
  );
  // The renderer's pattern does not match this, so the braces reach the speaker.
  assert.deepEqual(
    receiptDefects("We got {{talkTitle}}", "<p>Hi {{ speaker-name }}</p>"),
    ["malformed_placeholder"],
  );
  assert.deepEqual(receiptDefects("   ", "<p>{{talkTitle}}</p>"), ["empty_subject"]);
  // A body that is nothing but disallowed markup is empty once sanitized.
  assert.deepEqual(
    receiptDefects("We got {{talkTitle}}", "<script>alert(1)</script>").includes("empty_body"),
    true,
  );
  // Defects are reported together rather than one per round trip.
  assert.deepEqual(
    receiptDefects("We got it", "<p>Hi {{speakerName}} — {{portalLink}}</p>"),
    ["missing_required", "unfilled_placeholder"],
  );
});

test("the contract judges the sanitized body, so stripped markup is not counted against it", () => {
  // The renderer sanitizes before substituting; the check must see the same text.
  assert.deepEqual(
    receiptDefects("We got {{talkTitle}}", "<p onclick=\"steal()\">Hi {{speakerName}}</p><script>alert(1)</script>"),
    [],
  );
});

test("a rejected legacy row falls back to copy that carries no placeholder braces at all", () => {
  // The whole point of falling back: the speaker never sees `{{...}}` or a gap
  // where a value should have been.
  const defects = receiptDefects("We got it", "<p>Hi {{speakerName}} — {{portalLink}}</p>");
  assert.ok(defects.length > 0);
  const fallback = buildSubmissionReceipt({
    eventName: "Forward 2026",
    speaker: { name: "Sofia Marques", email: "speaker@example.test" },
    title: "Scaling Vector Search",
  });
  assert.ok(!fallback.html.includes("{{"));
  assert.ok(!fallback.subject.includes("{{"));
  assert.match(fallback.html, /Scaling Vector Search/);
});

test("template subjects are normalized before persistence or preview", () => {
  const parsed = emailTemplateUpdateSchema.safeParse({
    subject: " Hello\r\nBcc:\u0000 nope@example.test ",
    htmlBody: "<p>ok</p>",
  });
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.subject, "Hello Bcc: nope@example.test");
});
