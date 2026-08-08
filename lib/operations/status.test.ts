import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeImportError,
  describeImportSummary,
  describeMirrorReport,
  describeReminderResult,
  integrationStatus,
  IMPORT_TARGETS,
} from "./status";

const base = { name: "Airtable", action: "copy the programme to Airtable" };

test("integration status mirrors the server's own mode resolution", () => {
  // Demo mode wins over credentials, exactly like resolveAirtableMirrorMode.
  assert.equal(integrationStatus({ ...base, mocked: true, configured: true }).tone, "mock");
  assert.equal(integrationStatus({ ...base, mocked: false, configured: true }).tone, "live");
  assert.equal(integrationStatus({ ...base, mocked: false, configured: false }).tone, "unconfigured");
  // Missing credentials must not look "live" just because demo mode is off.
  assert.equal(integrationStatus({ ...base, mocked: true, configured: false }).tone, "unconfigured");
});

test("only a genuinely connected integration claims it will write", () => {
  assert.equal(integrationStatus({ ...base, mocked: false, configured: true }).writesExternally, true);
  for (const input of [{ mocked: true, configured: true }, { mocked: false, configured: false }]) {
    const status = integrationStatus({ ...base, ...input });
    assert.equal(status.writesExternally, false);
    assert.match(status.detail, /not|nothing/i);
  }
});

test("mirror outcomes read as advice, and a total failure says nothing was half-written", () => {
  const complete = describeMirrorReport({ status: "complete", attempted: 36, upserted: 36, failed: 0, tables: [] });
  assert.equal(complete.tone, "good");
  assert.match(complete.advice, /safe/);

  const partial = describeMirrorReport({ status: "partial", attempted: 36, upserted: 35, failed: 1, tables: [] });
  assert.equal(partial.tone, "warn");
  assert.match(partial.headline, /35 of 36/);
  assert.match(partial.advice, /run this again/);

  const failed = describeMirrorReport({ status: "failed", attempted: 36, upserted: 0, failed: 36, tables: [] });
  assert.equal(failed.tone, "bad");
  assert.match(failed.advice, /half-written/);
});

test("reminder results never claim delivery in demo mode", () => {
  const mocked = describeReminderResult({ recipientCount: 12, sent: 12, failed: 0, mocked: true });
  assert.match(mocked.headline, /Nothing was actually sent/);
  assert.equal(mocked.tone, "warn");

  assert.equal(describeReminderResult({ recipientCount: 12, sent: 12, failed: 0, mocked: false }).tone, "good");
  assert.equal(describeReminderResult({ recipientCount: 0, sent: 0, failed: 0, mocked: false }).tone, "warn");
  assert.match(describeReminderResult({ recipientCount: 3, sent: 2, failed: 1, mocked: false }).headline, /1 could not be delivered/);
  // Singular/plural must read correctly for one recipient.
  assert.match(describeReminderResult({ recipientCount: 1, sent: 1, failed: 0, mocked: false }).headline, /1 of 1 speaker\b/);
});

test("import summaries omit the zeroes an operator does not care about", () => {
  assert.equal(describeImportSummary({ rows: 5, created: 5, updated: 0, skipped: 0 }), "5 rows read · 5 added.");
  assert.equal(describeImportSummary({ rows: 1, created: 0, updated: 1, skipped: 0 }), "1 row read · 1 updated.");
  assert.equal(describeImportSummary({ rows: 3, created: 1, updated: 1, skipped: 1 }), "3 rows read · 1 added · 1 updated · 1 already up to date.");
});

test("import errors surface the spreadsheet row number", () => {
  assert.deepEqual(describeImportError("Row 4: title is required."), { row: 4, text: "title is required." });
  assert.deepEqual(describeImportError("Missing required mapping: title."), { row: null, text: "Missing required mapping: title." });
});

test("the mapping form offers exactly the importer's required targets", () => {
  const required = IMPORT_TARGETS.filter((target) => target.required).map((target) => target.value).sort();
  assert.deepEqual(required, ["formConfigId", "speakerEmail", "speakerName", "title"]);
});
