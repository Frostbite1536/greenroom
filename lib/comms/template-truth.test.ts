import assert from "node:assert/strict";
import test from "node:test";
import {
  fixedTemplatePreview,
  isEditableTemplateKey,
  readOnlyTemplateRefusal,
  submissionReceiptVariables,
  templateDelivery,
} from "./template-truth";
import { buildDecisionEmail, CFP_SUBMITTED_TEMPLATE_KEY } from "./notifications";
import { renderEmailTemplate } from "./reminders";
import { DEMO_EMAIL_TEMPLATES } from "@/lib/demo/seed";

/**
 * C21 (audit4#30). Every seeded template must be in exactly one honest state:
 * its stored wording drives the send, or it is read-only and previews the real
 * fixed message. These tests are the record of which is which.
 */

test("every seeded template declares a delivery mode, and only code-built ones are read-only", () => {
  const modes = Object.fromEntries(
    DEMO_EMAIL_TEMPLATES.map((template) => [template.key, templateDelivery(template.key)]),
  );

  const readOnly = Object.entries(modes).filter(([, delivery]) => !delivery.editable).map(([key]) => key).sort();
  assert.deepEqual(readOnly, ["cfp-accepted", "cfp-rejected"]);

  const editable = Object.entries(modes).filter(([, delivery]) => delivery.editable).map(([key]) => key).sort();
  assert.deepEqual(editable, ["cfp-submitted", "session-scheduled", "task-reminder"]);

  // Every template says something concrete about when it goes out.
  for (const [key, delivery] of Object.entries(modes)) {
    assert.ok(delivery.summary.trim().length > 0, `${key} has no delivery summary`);
  }
});

test("the reviewer invite template stays editable — its send really renders it", () => {
  assert.equal(isEditableTemplateKey("reviewer-invite"), true);
});

test("an operator-created template key is editable rather than cautiously locked", () => {
  const delivery = templateDelivery("some-custom-reminder");
  assert.equal(delivery.editable, true);
  assert.equal(delivery.mode, "stored");
});

test("a read-only preview is the real message, produced by the builder the send path calls", () => {
  // Not a transcription: byte-identical to what `/api/comms/decision` renders
  // for the same inputs, so the preview cannot drift away from the send.
  for (const [key, decision] of [["cfp-accepted", "ACCEPTED"], ["cfp-rejected", "REJECTED"]] as const) {
    const preview = fixedTemplatePreview(key);
    assert.ok(preview, `${key} must preview a real message`);
    const real = buildDecisionEmail({
      eventName: "Forward 2026",
      speaker: { name: "Sofia Marques", email: "speaker@example.test" },
      title: "Scaling Vector Search",
      decision,
    });
    assert.deepEqual(preview, real);
  }
});

test("only read-only templates carry a fixed preview, and each explains its refusal", () => {
  for (const template of DEMO_EMAIL_TEMPLATES) {
    const delivery = templateDelivery(template.key);
    const preview = fixedTemplatePreview(template.key);
    assert.equal(preview !== null, !delivery.editable, `${template.key} preview/editable disagree`);
    if (!delivery.editable) {
      assert.ok((delivery.reason ?? "").trim().length > 0, `${template.key} must say why it is locked`);
      assert.ok(readOnlyTemplateRefusal(template.key).trim().length > 0);
    }
  }
});

test("the accepted and declined previews are different messages", () => {
  assert.notEqual(fixedTemplatePreview("cfp-accepted")?.html, fixedTemplatePreview("cfp-rejected")?.html);
});

test("editing the stored submission receipt changes the rendered message", () => {
  const variables = submissionReceiptVariables({
    eventName: "Forward 2026",
    speakerName: "Sofia Marques",
    title: "Scaling Vector Search",
  });
  const seeded = DEMO_EMAIL_TEMPLATES.find((template) => template.key === CFP_SUBMITTED_TEMPLATE_KEY);
  assert.ok(seeded);

  const before = renderEmailTemplate(seeded, variables);
  assert.match(before.html, /Sofia Marques/);
  assert.match(before.html, /Scaling Vector Search/);

  const after = renderEmailTemplate(
    { subject: "Proposal received: {{talkTitle}}", htmlBody: "<p>Thanks {{speakerName}} — we have {{talkTitle}}.</p>" },
    variables,
  );
  assert.equal(after.subject, "Proposal received: Scaling Vector Search");
  assert.match(after.html, /Thanks Sofia Marques — we have Scaling Vector Search\./);
  assert.notEqual(after.html, before.html);
});

test("a hostile stored receipt body is stripped and speaker text is escaped, not executed", () => {
  const rendered = renderEmailTemplate(
    { subject: "Received", htmlBody: "<p>Hi {{speakerName}}</p><script>alert(1)</script><p onclick=\"steal()\">{{talkTitle}}</p>" },
    submissionReceiptVariables({
      eventName: "Forward 2026",
      speakerName: "Sofia Marques",
      title: "<img src=x onerror=alert(1)>",
    }),
  );
  assert.ok(!rendered.html.includes("<script"));
  assert.ok(!rendered.html.includes("onclick"));
  // The speaker-supplied title survives as visible text, never as markup.
  assert.ok(!rendered.html.includes("<img"));
  assert.match(rendered.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("receipt variables carry the proposal title under the name the template uses", () => {
  assert.deepEqual(
    submissionReceiptVariables({ eventName: "Forward 2026", speakerName: "Sofia", title: "A talk" }),
    { speakerName: "Sofia", eventName: "Forward 2026", talkTitle: "A talk" },
  );
});
