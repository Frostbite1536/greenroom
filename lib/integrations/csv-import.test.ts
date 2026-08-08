import assert from "node:assert/strict";
import test from "node:test";
import {
  CsvImportError,
  mapCsvRows,
  parseCsv,
  validateAbstractMappings,
} from "@/lib/integrations/csv-import";

test("parseCsv supports BOMs, quoted commas, and escaped quotes", () => {
  const parsed = parseCsv('\uFEFFTitle,Speaker\n"Platform, scale","Ada ""The Builder"""');

  assert.deepEqual(parsed.headers, ["Title", "Speaker"]);
  assert.deepEqual(parsed.rows, [
    {
      rowNumber: 2,
      values: { Title: "Platform, scale", Speaker: 'Ada "The Builder"' },
    },
  ]);
});

test("mapped rows use explicit fallbacks when a CSV cell is empty", () => {
  const parsed = parseCsv("Title,Email,Name\nA talk,ada@example.test,Ada");
  const mappings = validateAbstractMappings([
    { sourceField: "Title", targetField: "title" },
    { sourceField: "Email", targetField: "speakerEmail" },
    { sourceField: "Name", targetField: "speakerName" },
    { sourceField: "Unused", targetField: "formConfigId", fallback: "form-1" },
    { sourceField: "Unused", targetField: "format", fallback: "Talk" },
  ]);

  assert.deepEqual(mapCsvRows(parsed, mappings), [
    {
      rowNumber: 2,
      values: {
        title: "A talk",
        speakerEmail: "ada@example.test",
        speakerName: "Ada",
        formConfigId: "form-1",
        format: "Talk",
      },
    },
  ]);
});

test("abstract mappings reject missing required and unsupported targets", () => {
  assert.throws(
    () => validateAbstractMappings([{ sourceField: "Title", targetField: "title" }]),
    (error: unknown) => error instanceof CsvImportError && /Missing required mapping/.test(error.message),
  );
  assert.throws(
    () =>
      validateAbstractMappings([
        { sourceField: "Title", targetField: "title" },
        { sourceField: "Email", targetField: "speakerEmail" },
        { sourceField: "Name", targetField: "speakerName" },
        { sourceField: "Form", targetField: "formConfigId" },
        { sourceField: "Unsafe", targetField: "status" },
      ]),
    (error: unknown) => error instanceof CsvImportError && /Unsupported abstract import target/.test(error.message),
  );
});
